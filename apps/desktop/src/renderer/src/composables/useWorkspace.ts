import { computed, ref } from "vue";
import type { CodeCompletionTextEdit, CodeWorkspaceEdit } from "@qoder-open/shared";
import type { QoderDesktopApi } from "../../../preload";
import type {
  GitBranchInfo,
  GitDiff,
  GitStatus,
  OpenTab,
  SearchMatch,
  ShellResult,
  TreeRow,
  WorkspaceSnapshot
} from "../types";
import { badgeForPath, buildTree, fileName, flattenTree, languageForPath } from "../utils/tree";
import { applyTextEdits, collectWorkspaceEditGroups } from "../utils/workspace-edit";

export interface ApplyWorkspaceEditOptions {
  title?: string;
  source?: string;
}

export interface ApplyWorkspaceEditResult {
  changedPaths: string[];
  dirtyPaths: string[];
  savedPaths: string[];
  skippedUris: string[];
  undo?: () => Promise<void>;
}

interface WorkspaceEditFileState {
  path: string;
  content: string;
  existedOnDisk: boolean;
  wasOpen: boolean;
  savedContent?: string;
  wasDirty?: boolean;
}

export function useWorkspace(
  qoder: QoderDesktopApi,
  pushTerminalLine: (text: string, tone?: "normal" | "muted" | "success" | "error") => void
) {
  const workspace = ref<WorkspaceSnapshot | null>(null);
  const expandedPaths = ref(new Set<string>());
  const openTabs = ref<OpenTab[]>([]);
  const selectedFile = ref("");
  const selectedFileContent = ref("");
  const loadError = ref("");
  const searchResults = ref<SearchMatch[]>([]);
  const gitStatus = ref<GitStatus | null>(null);
  const gitDiff = ref<GitDiff | null>(null);
  const gitBranches = ref<GitBranchInfo[]>([]);
  const selectedGitFile = ref("");
  const commandBusy = ref(false);
  const saveBusy = ref(false);
  const gitBusy = ref(false);

  const tree = computed(() => buildTree(workspace.value?.files ?? []));
  const visibleTreeRows = computed(() => flattenTree(tree.value, expandedPaths.value));
  const selectedFileName = computed(() => fileName(selectedFile.value) || "workspace");
  const workspaceLabel = computed(() => workspace.value?.name.toUpperCase() ?? "QODER OPEN");
  const workspacePath = computed(() => workspace.value?.cwd ?? "");
  const pendingChanges = computed(() => gitStatus.value?.files.length ?? 0);
  const breadcrumbItems = computed(() => {
    const path = selectedFile.value || "README.md";
    return path.split(/[\\/]/).filter(Boolean);
  });
  const displayContent = computed(() => selectedFile.value ? selectedFileContent.value : fallbackCode);
  const selectedTab = computed(() => openTabs.value.find((tab) => tab.path === selectedFile.value));
  const selectedFileDirty = computed(() => selectedTab.value?.isDirty ?? false);
  const dirtyTabs = computed(() => openTabs.value.filter((tab) => tab.isDirty));
  const canSaveSelectedFile = computed(
    () => Boolean(selectedFile.value) && selectedFileDirty.value && !saveBusy.value
  );
  const languageMode = computed(() => languageForPath(selectedFile.value));

  async function loadWorkspace(snapshot?: WorkspaceSnapshot): Promise<void> {
    try {
      workspace.value = snapshot ?? (await qoder.workspace.get());
      loadError.value = "";
      expandedPaths.value = new Set(
        workspace.value.files
          .filter((entry) => entry.kind === "directory" && entry.path.split("/").length <= 2)
          .map((entry) => entry.path)
      );

      if (openTabs.value.length === 0) {
        const preferred =
          workspace.value.files.find((entry) => entry.path === "apps/desktop/src/renderer/src/App.vue") ??
          workspace.value.files.find((entry) => entry.path === "README.md") ??
          workspace.value.files.find((entry) => /\.(ts|tsx|js|jsx|vue|json|md)$/i.test(entry.path));

        if (preferred) {
          await openFile(preferred.path);
        }
      }

      await refreshGitStatus();
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : String(error);
      pushTerminalLine(`[workspace:error] ${loadError.value}`, "error");
    }
  }

  async function chooseFolder(): Promise<void> {
    const snapshot = await qoder.workspace.openFolder();
    openTabs.value = [];
    selectedFile.value = "";
    selectedFileContent.value = "";
    searchResults.value = [];
    saveBusy.value = false;
    await loadWorkspace(snapshot);
  }

  async function openFileFromDialog(): Promise<void> {
    try {
      const result = await qoder.workspace.openFileDialog();
      workspace.value = result.snapshot;
      resetExpandedPaths();

      if (result.filePath) {
        await openFile(result.filePath);
      }

      await refreshGitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushTerminalLine(`[open:error] ${message}`, "error");
      loadError.value = message;
    }
  }

  async function openFile(path: string): Promise<void> {
    try {
      const existingTab = openTabs.value.find((tab) => tab.path === path);

      if (existingTab) {
        selectOpenTab(existingTab);
        return;
      }

      const result = await qoder.workspace.readFile(path);
      const tab: OpenTab = {
        path: result.path,
        label: fileName(result.path),
        content: result.content,
        savedContent: result.content,
        isDirty: false
      };

      openTabs.value.push(tab);
      selectOpenTab(tab);
      loadError.value = "";
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : String(error);
      pushTerminalLine(`[file:error] ${loadError.value}`, "error");
    }
  }

  function updateSelectedFileContent(content: string): void {
    selectedFileContent.value = content;

    if (!selectedFile.value) {
      return;
    }

    const currentTab = openTabs.value.find((tab) => tab.path === selectedFile.value);
    const savedContent = currentTab?.savedContent ?? "";
    updateOpenTab(selectedFile.value, {
      content,
      isDirty: content !== savedContent
    });
  }

  async function saveSelectedFile(): Promise<void> {
    if (!selectedFile.value || saveBusy.value) {
      return;
    }

    const path = selectedFile.value;
    const content = selectedFileContent.value;
    saveBusy.value = true;

    try {
      const result = await qoder.workspace.writeFile({ path, content });
      updateOpenTab(path, {
        content,
        savedContent: content,
        isDirty: false
      });
      await notifyLanguageDocumentSaved(path, content);
      pushTerminalLine(`[save] ${result.path} (${result.bytes} bytes)`, "success");
      await refreshGitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushTerminalLine(`[save:error] ${message}`, "error");
      loadError.value = message;
    } finally {
      saveBusy.value = false;
    }
  }

  async function saveSelectedFileAs(): Promise<void> {
    if (!selectedFile.value || saveBusy.value) {
      return;
    }

    const previousPath = selectedFile.value;
    const content = selectedFileContent.value;
    saveBusy.value = true;

    try {
      const result = await qoder.workspace.saveFileAs({
        suggestedPath: previousPath,
        content
      });

      if (!result) {
        return;
      }

      workspace.value = result.snapshot;
      resetExpandedPaths();
      replaceOrOpenSavedTab(previousPath, result.path, content);
      await notifyLanguageDocumentSaved(result.path, content);
      pushTerminalLine(`[save-as] ${result.path} (${result.bytes} bytes)`, "success");
      await refreshGitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushTerminalLine(`[save-as:error] ${message}`, "error");
      loadError.value = message;
    } finally {
      saveBusy.value = false;
    }
  }

  async function saveAllFiles(): Promise<void> {
    if (dirtyTabs.value.length === 0 || saveBusy.value) {
      return;
    }

    saveBusy.value = true;

    try {
      for (const tab of dirtyTabs.value) {
        const result = await qoder.workspace.writeFile({
          path: tab.path,
          content: tab.content
        });
        updateOpenTab(tab.path, {
          savedContent: tab.content,
          isDirty: false
        });
        await notifyLanguageDocumentSaved(tab.path, tab.content);
        pushTerminalLine(`[save] ${result.path} (${result.bytes} bytes)`, "success");
      }

      if (selectedFile.value) {
        const currentTab = openTabs.value.find((tab) => tab.path === selectedFile.value);
        selectedFileContent.value = currentTab?.content ?? selectedFileContent.value;
      }

      await refreshGitStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushTerminalLine(`[save-all:error] ${message}`, "error");
      loadError.value = message;
    } finally {
      saveBusy.value = false;
    }
  }

  async function applyWorkspaceEdit(
    edit: CodeWorkspaceEdit,
    options: ApplyWorkspaceEditOptions = {}
  ): Promise<ApplyWorkspaceEditResult> {
    const { groups, skippedUris } = collectWorkspaceEditGroups(edit);
    const result: ApplyWorkspaceEditResult = {
      changedPaths: [],
      dirtyPaths: [],
      savedPaths: [],
      skippedUris
    };
    const beforeStates: WorkspaceEditFileState[] = [];

    if (groups.length === 0) {
      pushTerminalLine("[edit] No workspace changes returned by language server.", "muted");
      return result;
    }

    const managesBusyState = !saveBusy.value;

    if (managesBusyState) {
      saveBusy.value = true;
    }

    try {
      for (const group of groups) {
        const tab = openTabs.value.find((item) => item.path === group.path);
        const previousFile = tab
          ? {
              content: tab.content,
              existedOnDisk: true
            }
          : await readFileForWorkspaceEdit(qoder, group.path, group.edits);
        const previousContent = previousFile.content;
        const nextContent = applyTextEdits(previousContent, group.edits);

        if (nextContent === previousContent) {
          continue;
        }

        beforeStates.push({
          path: group.path,
          content: previousContent,
          existedOnDisk: previousFile.existedOnDisk,
          wasOpen: Boolean(tab),
          savedContent: tab?.savedContent,
          wasDirty: tab?.isDirty
        });
        result.changedPaths.push(group.path);

        if (tab) {
          const nextIsDirty = nextContent !== tab.savedContent;

          updateOpenTab(group.path, {
            content: nextContent,
            isDirty: nextIsDirty
          });

          if (selectedFile.value === group.path) {
            selectedFileContent.value = nextContent;
          }

          await syncLanguageDocument(group.path, nextContent);

          if (nextIsDirty) {
            result.dirtyPaths.push(group.path);
          }

          continue;
        }

        const writeResult = await qoder.workspace.writeFile({
          path: group.path,
          content: nextContent
        });
        await notifyLanguageDocumentSaved(group.path, nextContent);
        result.savedPaths.push(writeResult.path);
      }

      if (result.savedPaths.length > 0) {
        workspace.value = await qoder.workspace.get();
        resetExpandedPaths();
        await refreshGitStatus();
      }

      if (result.changedPaths.length > 0) {
        result.undo = () => undoWorkspaceEdit(beforeStates);
        pushTerminalLine(workspaceEditSummary(result, options), "success");
      }

      if (skippedUris.length > 0) {
        pushTerminalLine(
          `[edit:skip] ${skippedUris.length} external file edit(s) were ignored for workspace safety.`,
          "muted"
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushTerminalLine(`[edit:error] ${message}`, "error");
      loadError.value = message;
      throw error;
    } finally {
      if (managesBusyState) {
        saveBusy.value = false;
      }
    }

    return result;
  }

  async function runSourceAction(kind: string, title: string): Promise<void> {
    if (!selectedFile.value) {
      return;
    }

    const languageId = languageIdForPath(selectedFile.value);

    if (languageId === "plaintext") {
      pushTerminalLine(`[language] ${title} is not available for ${selectedFile.value}.`, "muted");
      return;
    }

    try {
      const actions = await qoder.language.codeActions({
        languageId,
        path: selectedFile.value,
        content: selectedFileContent.value,
        range: {
          start: {
            line: 0,
            character: 0
          },
          end: {
            line: 0,
            character: 0
          }
        },
        diagnostics: [],
        only: kind
      });

      let applied = false;

      for (const action of actions) {
        const resolved = await qoder.language.resolveCodeAction({
          languageId,
          action
        });

        if (resolved.edit) {
          const editResult = await applyWorkspaceEdit(resolved.edit, {
            title: resolved.title || title,
            source: "source-action"
          });
          applied = applied || editResult.changedPaths.length > 0;
        }

        if (resolved.command) {
          const commandResult = await qoder.language.executeCommand({
            languageId,
            command: resolved.command
          });

          for (const edit of commandResult.workspaceEdits) {
            const editResult = await applyWorkspaceEdit(edit, {
              title: resolved.title || title,
              source: "source-action"
            });
            applied = applied || editResult.changedPaths.length > 0;
          }
        }
      }

      if (!applied) {
        pushTerminalLine(`[language] ${title}: no changes returned.`, "muted");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushTerminalLine(`[language:error] ${title}: ${message}`, "error");
    }
  }

  async function notifyLanguageDocumentSaved(path: string, content: string): Promise<void> {
    try {
      await qoder.language.didSaveDocument({
        languageId: languageIdForPath(path),
        path,
        content
      });
    } catch {
      // Saving the file is authoritative; language server notifications are best-effort.
    }
  }

  async function syncLanguageDocument(path: string, content: string): Promise<void> {
    try {
      await qoder.language.syncDocument({
        languageId: languageIdForPath(path),
        path,
        content
      });
    } catch {
      // The editor state is still authoritative; LSP sync is best-effort.
    }
  }

  async function undoWorkspaceEdit(beforeStates: WorkspaceEditFileState[]): Promise<void> {
    if (beforeStates.length === 0) {
      return;
    }

    const managesBusyState = !saveBusy.value;
    let restoredDiskFiles = 0;
    let restoredOpenTabs = 0;
    let skippedClosedTabs = 0;

    if (managesBusyState) {
      saveBusy.value = true;
    }

    try {
      for (const state of beforeStates) {
        const tab = openTabs.value.find((item) => item.path === state.path);

        if (state.wasOpen) {
          if (!tab) {
            skippedClosedTabs += 1;
            continue;
          }

          updateOpenTab(state.path, {
            content: state.content,
            savedContent: state.savedContent,
            isDirty: state.wasDirty ?? state.content !== state.savedContent
          });

          if (selectedFile.value === state.path) {
            selectedFileContent.value = state.content;
          }

          await syncLanguageDocument(state.path, state.content);
          restoredOpenTabs += 1;
          continue;
        }

        if (!state.existedOnDisk) {
          continue;
        }

        await qoder.workspace.writeFile({
          path: state.path,
          content: state.content
        });
        await notifyLanguageDocumentSaved(state.path, state.content);
        restoredDiskFiles += 1;
      }

      if (restoredDiskFiles > 0) {
        workspace.value = await qoder.workspace.get();
        resetExpandedPaths();
        await refreshGitStatus();
      }

      const details = [
        restoredOpenTabs > 0 ? `${restoredOpenTabs} open tab(s)` : "",
        restoredDiskFiles > 0 ? `${restoredDiskFiles} disk file(s)` : "",
        skippedClosedTabs > 0 ? `${skippedClosedTabs} closed tab(s) skipped` : ""
      ].filter(Boolean);
      pushTerminalLine(`[undo-edit] restored ${details.join(", ") || "nothing"}`, "muted");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushTerminalLine(`[undo-edit:error] ${message}`, "error");
      throw error;
    } finally {
      if (managesBusyState) {
        saveBusy.value = false;
      }
    }
  }

  function discardSelectedChanges(): void {
    if (!selectedFile.value) {
      return;
    }

    const tab = openTabs.value.find((item) => item.path === selectedFile.value);

    if (!tab) {
      return;
    }

    selectedFileContent.value = tab.savedContent;
    updateOpenTab(tab.path, {
      content: tab.savedContent,
      isDirty: false
    });
    pushTerminalLine(`[revert] ${tab.path}`, "muted");
  }

  async function createFile(): Promise<void> {
    const requestedPath = window.prompt("New file path");
    const path = requestedPath?.trim().replace(/\\/g, "/");

    if (!path) {
      return;
    }

    try {
      const existingEntry = workspace.value?.files.find((entry) => entry.path === path);

      if (existingEntry?.kind === "file") {
        await openFile(path);
        return;
      }

      if (existingEntry?.kind === "directory") {
        throw new Error(`Path is a directory: ${path}`);
      }

      await qoder.workspace.writeFile({ path, content: "" });
      workspace.value = await qoder.workspace.get();
      await openFile(path);
      await refreshGitStatus();
      pushTerminalLine(`[create] ${path}`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushTerminalLine(`[create:error] ${message}`, "error");
      loadError.value = message;
    }
  }

  async function createTextFile(): Promise<void> {
    try {
      const path = nextUntitledPath();
      await qoder.workspace.writeFile({ path, content: "" });
      workspace.value = await qoder.workspace.get();
      resetExpandedPaths();
      await openFile(path);
      await refreshGitStatus();
      pushTerminalLine(`[create] ${path}`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushTerminalLine(`[create:error] ${message}`, "error");
      loadError.value = message;
    }
  }

  async function selectTreeRow(row: TreeRow): Promise<void> {
    if (row.kind === "directory") {
      toggleDirectory(row.path);
      return;
    }

    await openFile(row.path);
  }

  function toggleDirectory(path: string): void {
    const next = new Set(expandedPaths.value);

    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }

    expandedPaths.value = next;
  }

  function closeTab(path: string): void {
    const index = openTabs.value.findIndex((tab) => tab.path === path);
    const targetTab = openTabs.value[index];

    if (targetTab?.isDirty && !window.confirm(`Discard unsaved changes to ${targetTab.label}?`)) {
      return;
    }

    const nextTabs = openTabs.value.filter((tab) => tab.path !== path);
    openTabs.value = nextTabs;

    if (selectedFile.value === path) {
      const nextTab = nextTabs[Math.max(0, index - 1)] ?? nextTabs[index];
      if (nextTab) {
        selectOpenTab(nextTab);
      } else {
        selectedFile.value = "";
        selectedFileContent.value = "";
      }
    }
  }

  function closeSelectedFile(): void {
    if (!selectedFile.value) {
      return;
    }

    closeTab(selectedFile.value);
  }

  function selectOpenTab(tab: OpenTab): void {
    selectedFile.value = tab.path;
    selectedFileContent.value = tab.content;
    loadError.value = "";
  }

  function updateOpenTab(path: string, patch: Partial<OpenTab>): void {
    openTabs.value = openTabs.value.map((tab) => (tab.path === path ? { ...tab, ...patch } : tab));
  }

  function replaceOrOpenSavedTab(previousPath: string, nextPath: string, content: string): void {
    const nextTab: OpenTab = {
      path: nextPath,
      label: fileName(nextPath),
      content,
      savedContent: content,
      isDirty: false
    };
    const previousIndex = openTabs.value.findIndex((tab) => tab.path === previousPath);
    const tabsWithoutNext = openTabs.value.filter((tab) => tab.path !== nextPath);

    if (previousIndex >= 0) {
      const adjustedIndex = tabsWithoutNext.findIndex((tab) => tab.path === previousPath);
      tabsWithoutNext.splice(adjustedIndex >= 0 ? adjustedIndex : previousIndex, 1, nextTab);
      openTabs.value = tabsWithoutNext;
    } else {
      openTabs.value = [...tabsWithoutNext, nextTab];
    }

    selectOpenTab(nextTab);
  }

  function resetExpandedPaths(): void {
    expandedPaths.value = new Set(
      workspace.value?.files
        .filter((entry) => entry.kind === "directory" && entry.path.split("/").length <= 2)
        .map((entry) => entry.path) ?? []
    );
  }

  function nextUntitledPath(): string {
    const existingPaths = new Set([
      ...(workspace.value?.files.map((entry) => entry.path) ?? []),
      ...openTabs.value.map((tab) => tab.path)
    ]);

    if (!existingPaths.has("untitled.txt")) {
      return "untitled.txt";
    }

    for (let index = 1; index < 10_000; index += 1) {
      const candidate = `untitled-${index}.txt`;

      if (!existingPaths.has(candidate)) {
        return candidate;
      }
    }

    return `untitled-${Date.now()}.txt`;
  }

  async function runSearch(payload: { query: string; glob?: string }): Promise<void> {
    try {
      searchResults.value = await qoder.workspace.search(payload);
      pushTerminalLine(
        `[search] ${payload.query || "(empty)"} -> ${searchResults.value.length} matches`,
        searchResults.value.length > 0 ? "success" : "muted"
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushTerminalLine(`[search:error] ${message}`, "error");
    }
  }

  async function openSearchMatch(match: SearchMatch): Promise<void> {
    await openFile(match.path);
    pushTerminalLine(`[open] ${match.path}:${match.line}`, "muted");
  }

  async function refreshGitStatus(): Promise<void> {
    gitStatus.value = await qoder.workspace.gitStatus();
    gitBranches.value = await qoder.workspace.gitBranches();
    const status = gitStatus.value.clean
      ? "clean"
      : `${gitStatus.value.files.length} changed files`;
    pushTerminalLine(`[git] ${gitStatus.value.branch ?? "workspace"} ${status}`, "muted");
  }

  async function openGitDiff(path: string): Promise<void> {
    if (!path) {
      return;
    }

    selectedGitFile.value = path;
    gitBusy.value = true;

    try {
      gitDiff.value = await qoder.workspace.gitDiff(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushTerminalLine(`[git:diff:error] ${message}`, "error");
    } finally {
      gitBusy.value = false;
    }
  }

  async function stageGitFile(path: string): Promise<void> {
    await runGitOperation(
      "stage",
      async () => {
        gitStatus.value = await qoder.workspace.gitStage(path);
      },
      path
    );
  }

  async function stageAllGitFiles(): Promise<void> {
    await runGitOperation("stage-all", async () => {
      gitStatus.value = await qoder.workspace.gitStageAll();
    });
  }

  async function unstageGitFile(path: string): Promise<void> {
    await runGitOperation(
      "unstage",
      async () => {
        gitStatus.value = await qoder.workspace.gitUnstage(path);
      },
      path
    );
  }

  async function discardGitFile(path: string): Promise<void> {
    if (!path || !window.confirm(`Discard all local changes in ${path}? This cannot be undone.`)) {
      return;
    }

    await runGitOperation(
      "discard",
      async () => {
        gitStatus.value = await qoder.workspace.gitDiscard(path);
        await syncOpenTabAfterFileMutation(path);
        workspace.value = await qoder.workspace.get();
        resetExpandedPaths();
      },
      path
    );
  }

  async function commitGitChanges(message: string): Promise<void> {
    const trimmed = message.trim();

    if (!trimmed) {
      pushTerminalLine("[git:commit:error] Commit message is required.", "error");
      return;
    }

    await runGitOperation("commit", async () => {
      const result = await qoder.workspace.gitCommit(trimmed);
      pushTerminalLine(
        result.output,
        result.ok ? "success" : "error"
      );

      if (result.ok) {
        await refreshGitStatus();
      }
    });
  }

  async function runGitOperation(
    label: string,
    operation: () => Promise<void>,
    path?: string
  ): Promise<void> {
    if (gitBusy.value) {
      return;
    }

    gitBusy.value = true;

    try {
      await operation();
      await refreshGitStatus();

      const currentGitFile = selectedGitFile.value;

      if (currentGitFile) {
        const stillChanged = gitStatus.value?.files.some((file) => file.path === currentGitFile);

        if (stillChanged) {
          gitDiff.value = await qoder.workspace.gitDiff(currentGitFile);
        } else {
          selectedGitFile.value = "";
          gitDiff.value = null;
        }
      }

      pushTerminalLine(`[git:${label}] ${path ?? "workspace"}`, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushTerminalLine(`[git:${label}:error] ${message}`, "error");
    } finally {
      gitBusy.value = false;
    }
  }

  async function syncOpenTabAfterFileMutation(path: string): Promise<void> {
    const tab = openTabs.value.find((item) => item.path === path);

    if (!tab) {
      return;
    }

    try {
      const result = await qoder.workspace.readFile(path);
      updateOpenTab(path, {
        content: result.content,
        savedContent: result.content,
        isDirty: false
      });

      if (selectedFile.value === path) {
        selectedFileContent.value = result.content;
      }
    } catch {
      closeTab(path);
    }
  }

  async function runCommand(command: string): Promise<ShellResult | undefined> {
    commandBusy.value = true;
    pushTerminalLine(`> ${command}`, "normal");

    try {
      const result = await qoder.terminal.run({ command });
      pushTerminalLine(result.output, result.ok ? "success" : "error");
      await refreshGitStatus();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushTerminalLine(`[command:error] ${message}`, "error");
      return undefined;
    } finally {
      commandBusy.value = false;
    }
  }

  return {
    workspace,
    expandedPaths,
    openTabs,
    selectedFile,
    selectedFileContent,
    loadError,
    searchResults,
    gitStatus,
    gitDiff,
    gitBranches,
    selectedGitFile,
    commandBusy,
    saveBusy,
    gitBusy,
    visibleTreeRows,
    selectedFileName,
    workspaceLabel,
    workspacePath,
    pendingChanges,
    breadcrumbItems,
    displayContent,
    selectedFileDirty,
    dirtyTabs,
    canSaveSelectedFile,
    languageMode,
    badgeForPath,
    loadWorkspace,
    chooseFolder,
    openFileFromDialog,
    openFile,
    updateSelectedFileContent,
    saveSelectedFile,
    saveSelectedFileAs,
    saveAllFiles,
    applyWorkspaceEdit,
    runSourceAction,
    discardSelectedChanges,
    createFile,
    createTextFile,
    selectTreeRow,
    closeTab,
    closeSelectedFile,
    runSearch,
    openSearchMatch,
    refreshGitStatus,
    openGitDiff,
    stageGitFile,
    stageAllGitFiles,
    unstageGitFile,
    discardGitFile,
    commitGitChanges,
    runCommand
  };
}

async function readFileForWorkspaceEdit(
  qoder: QoderDesktopApi,
  path: string,
  edits: CodeCompletionTextEdit[]
): Promise<{ content: string; existedOnDisk: boolean }> {
  try {
    return {
      content: (await qoder.workspace.readFile(path)).content,
      existedOnDisk: true
    };
  } catch (error) {
    if (canApplyEditsToEmptyFile(edits)) {
      return {
        content: "",
        existedOnDisk: false
      };
    }

    throw error;
  }
}

function canApplyEditsToEmptyFile(edits: CodeCompletionTextEdit[]): boolean {
  return edits.every((edit) => {
    const range = edit.range ?? edit.replace ?? edit.insert;

    if (!range) {
      return true;
    }

    return (
      range.start.line === 0 &&
      range.start.character === 0 &&
      range.end.line === 0 &&
      range.end.character === 0
    );
  });
}

function workspaceEditSummary(
  result: ApplyWorkspaceEditResult,
  options: ApplyWorkspaceEditOptions
): string {
  const title = options.title ? `${options.title}: ` : "";
  const details = [
    `${result.changedPaths.length} file(s) changed`,
    result.dirtyPaths.length > 0 ? `${result.dirtyPaths.length} open tab(s) dirty` : "",
    result.savedPaths.length > 0 ? `${result.savedPaths.length} unopened file(s) saved` : ""
  ].filter(Boolean);

  return `[edit] ${title}${details.join(", ")}`;
}

const fallbackCode = `export class QoderOpenWorkbench {
  constructor() {
    this.features = ["workspace", "search", "git", "terminal", "language-services"]
  }

  openEditor() {
    return "ready"
  }
}`;

function languageIdForPath(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    go: "go",
    py: "python",
    rs: "rust",
    vue: "vue"
  };

  return map[extension ?? ""] ?? "plaintext";
}
