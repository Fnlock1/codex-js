<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watchEffect } from "vue";
import ActivityBar from "./components/ActivityBar.vue";
import CommandPalette from "./components/CommandPalette.vue";
import EditorPane from "./components/EditorPane.vue";
import SidebarPanel from "./components/SidebarPanel.vue";
import StatusBar from "./components/StatusBar.vue";
import TerminalPanel from "./components/TerminalPanel.vue";
import TitleBar from "./components/TitleBar.vue";
import { useTerminal } from "./composables/useTerminal";
import { useWorkspace } from "./composables/useWorkspace";
import { setWorkspaceEditApplyHandler } from "./editor/language-features";
import type { ActivityId, DiagnosticProblem, PaletteCommand } from "./types";
import { createPreviewApi } from "./utils/preview-api";
import type {
  CodeDiagnosticsEvent,
  LanguageServerStatus,
  ProjectIndexSummary,
  ProjectIndexSymbol
} from "@qoder-open/shared";

interface TerminalSize {
  cols: number;
  rows: number;
}

const qoder = window.qoder ?? createPreviewApi();
const activeActivity = ref<ActivityId>("files");
const workspacePathForTerminal = ref("");
const terminal = useTerminal(workspacePathForTerminal);
const workspace = useWorkspace(qoder, terminal.pushTerminalLine);
const terminalPanelRef = ref<InstanceType<typeof TerminalPanel> | null>(null);
const terminalShellLabel = ref("PowerShell");
const lastTerminalSize = ref<TerminalSize>({ cols: 80, rows: 24 });
const terminalCreating = ref(false);
const languageServers = ref<LanguageServerStatus[]>([]);
const diagnosticsByPath = ref(new Map<string, CodeDiagnosticsEvent>());
const commandPaletteVisible = ref(false);
const projectIndexSummary = ref<ProjectIndexSummary | null>(null);
const paletteSymbols = ref<ProjectIndexSymbol[]>([]);

setWorkspaceEditApplyHandler((edit, options) => workspace.applyWorkspaceEdit(edit, options));

const removeTerminalDataListener = qoder.terminal.onData(({ sessionId, data }) => {
  if (sessionId === terminal.terminalSessionId.value) {
    terminalPanelRef.value?.writeData(data);
  }
});

const removeTerminalExitListener = qoder.terminal.onExit(({ sessionId, exitCode }) => {
  if (sessionId !== terminal.terminalSessionId.value) {
    return;
  }

  terminalPanelRef.value?.writeData(`\r\n[process exited with code ${exitCode}]\r\n`);
  terminal.clearTerminalSession();
});
const removeLanguageStatusListener = qoder.language.onStatusChanged((statuses) => {
  languageServers.value = statuses;
});
const removeDiagnosticsListener = qoder.language.onDiagnostics((event) => {
  if (!event.path) {
    return;
  }

  const nextDiagnostics = new Map(diagnosticsByPath.value);
  nextDiagnostics.set(event.path, event);
  diagnosticsByPath.value = nextDiagnostics;
});

const projectName = computed(() => workspace.workspace.value?.name ?? "qoder-open");
const statusText = computed(() => {
  if (!workspace.workspace.value) {
    return "Connecting workspace...";
  }

  const unsaved = workspace.selectedFileDirty.value ? " - unsaved changes" : "";
  return `${workspace.workspace.value.files.length} items${unsaved}`;
});
const diagnosticProblems = computed<DiagnosticProblem[]>(() =>
  Array.from(diagnosticsByPath.value.values()).flatMap((event) =>
    event.diagnostics.map((diagnostic, index) => ({
      id: `${event.path}:${diagnostic.range.start.line}:${diagnostic.range.start.character}:${index}:${diagnostic.message}`,
      path: event.path ?? "",
      line: diagnostic.range.start.line + 1,
      column: diagnostic.range.start.character + 1,
      severity: diagnosticSeverity(diagnostic.severity),
      message: diagnostic.message,
      source: diagnostic.source
    }))
  )
);
const paletteCommands = computed<PaletteCommand[]>(() => [
  {
    id: "file.newText",
    title: "File: New Text File",
    detail: "Create and open untitled.txt",
    shortcut: "Ctrl+N"
  },
  {
    id: "file.new",
    title: "File: New File...",
    detail: "Prompt for a workspace-relative path"
  },
  {
    id: "file.open",
    title: "File: Open File...",
    detail: "Open a file from disk",
    shortcut: "Ctrl+O"
  },
  {
    id: "file.save",
    title: "File: Save",
    detail: "Save the current editor tab",
    shortcut: "Ctrl+S"
  },
  {
    id: "file.saveAll",
    title: "File: Save All",
    detail: "Save every dirty tab"
  },
  {
    id: "terminal.show",
    title: "Terminal: Show Terminal",
    detail: "Focus the PTY terminal",
    shortcut: "Ctrl+`"
  },
  {
    id: "terminal.problems",
    title: "View: Show Problems",
    detail: `${diagnosticProblems.value.length} diagnostics from language services`
  },
  {
    id: "language.refresh",
    title: "Language Services: Refresh Status",
    detail: "Refresh LSP runtime status"
  },
  {
    id: "language.addMissingImports",
    title: "Language: Add Missing Imports",
    detail: "Ask the active language server to add imports for the current file"
  },
  {
    id: "language.organizeImports",
    title: "Language: Organize Imports",
    detail: "Ask the active language server to sort and remove imports"
  },
  {
    id: "index.rebuild",
    title: "Project Index: Rebuild",
    detail: projectIndexSummary.value
      ? `${projectIndexSummary.value.files} files / ${projectIndexSummary.value.symbols} symbols`
      : "Build lightweight project symbol index"
  }
]);

watchEffect(() => {
  workspacePathForTerminal.value = workspace.workspacePath.value;
});

onMounted(() => {
  void workspace.loadWorkspace();
  void refreshLanguageServers();
  void refreshProjectIndex();
  window.addEventListener("keydown", handleGlobalKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleGlobalKeydown);
  setWorkspaceEditApplyHandler(undefined);
  removeTerminalDataListener();
  removeTerminalExitListener();
  removeLanguageStatusListener();
  removeDiagnosticsListener();

  if (terminal.terminalSessionId.value) {
    void qoder.terminal.dispose(terminal.terminalSessionId.value);
  }
});

function handleGlobalKeydown(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey)) {
    return;
  }

  const key = event.key.toLowerCase();

  if (event.shiftKey && key === "p") {
    event.preventDefault();
    commandPaletteVisible.value = true;
    return;
  }

  if (event.shiftKey && key === "s") {
    event.preventDefault();
    void workspace.saveSelectedFileAs();
    return;
  }

  if (key === "s") {
    event.preventDefault();
    void workspace.saveSelectedFile();
    return;
  }

  if (key === "n") {
    event.preventDefault();
    void workspace.createTextFile();
    return;
  }

  if (key === "o") {
    event.preventDefault();
    void workspace.openFileFromDialog();
    return;
  }

  if (event.key === "`") {
    event.preventDefault();
    void showAndFocusTerminal();
  }
}

function handleFileAction(action: string): void {
  const actions: Record<string, () => void> = {
    "new-text-file": () => {
      void workspace.createTextFile();
    },
    "new-file": () => {
      void workspace.createFile();
    },
    "open-file": () => {
      void workspace.openFileFromDialog();
    },
    save: () => {
      void workspace.saveSelectedFile();
    },
    "save-as": () => {
      void workspace.saveSelectedFileAs();
    },
    "save-all": () => {
      void workspace.saveAllFiles();
    },
    "close-file": () => {
      workspace.closeSelectedFile();
    },
    "revert-file": () => {
      workspace.discardSelectedChanges();
    }
  };

  actions[action]?.();
}

function handleTerminalAction(action: string): void {
  const actions: Record<string, () => void> = {
    "new-terminal": () => {
      void restartPtyTerminal();
    },
    "show-terminal": () => {
      void showAndFocusTerminal();
    },
    "clear-terminal": () => {
      terminalPanelRef.value?.clearXterm();
      void showAndFocusTerminal();
    },
    "close-terminal": () => {
      terminal.hideTerminal();
    }
  };

  actions[action]?.();
}

async function showAndFocusTerminal(): Promise<void> {
  terminal.showTerminal();
  await nextTick();
  terminalPanelRef.value?.fitTerminal();

  if (!terminal.terminalSessionId.value) {
    await createPtyTerminal();
  }

  await focusTerminalInput();
}

async function focusTerminalInput(): Promise<void> {
  await nextTick();
  await terminalPanelRef.value?.focusInput();
}

async function restartPtyTerminal(): Promise<void> {
  terminal.showTerminal();
  await nextTick();
  await createPtyTerminal();
  await focusTerminalInput();
}

async function createPtyTerminal(size = terminalPanelRef.value?.getSize() ?? lastTerminalSize.value): Promise<void> {
  if (terminalCreating.value) {
    return;
  }

  terminalCreating.value = true;

  try {
    const previousSessionId = terminal.terminalSessionId.value;

    if (previousSessionId) {
      terminal.clearTerminalSession();
      await qoder.terminal.dispose(previousSessionId);
    }

    terminalPanelRef.value?.resetTerminal();
    terminalShellLabel.value = "Starting PTY...";

    const session = await qoder.terminal.create({
      cwd: workspace.workspacePath.value || undefined,
      cols: size.cols,
      rows: size.rows
    });

    terminal.setTerminalSessionId(session.sessionId);
    terminalShellLabel.value = basename(session.shell);
    terminalPanelRef.value?.fitTerminal();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    terminalPanelRef.value?.writeData(`\r\n[pty:error] ${message}\r\n`);
    terminal.clearTerminalSession();
    terminalShellLabel.value = "PTY failed";
  } finally {
    terminalCreating.value = false;
  }
}

function handleTerminalReady(size: TerminalSize): void {
  lastTerminalSize.value = size;

  if (!terminal.terminalSessionId.value) {
    void createPtyTerminal(size);
  }
}

function handleTerminalInput(data: string): void {
  if (!terminal.terminalSessionId.value) {
    return;
  }

  void qoder.terminal.write({
    sessionId: terminal.terminalSessionId.value,
    data
  });
}

function handleTerminalResize(size: TerminalSize): void {
  lastTerminalSize.value = size;

  if (!terminal.terminalSessionId.value) {
    return;
  }

  void qoder.terminal.resize({
    sessionId: terminal.terminalSessionId.value,
    cols: size.cols,
    rows: size.rows
  });
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function minimizeWindow(): void {
  void qoder.window.minimize();
}

function maximizeWindow(): void {
  void qoder.window.maximize();
}

function closeWindow(): void {
  void qoder.window.close();
}

async function refreshLanguageServers(): Promise<void> {
  languageServers.value = await qoder.language.status();
}

async function refreshProjectIndex(): Promise<void> {
  projectIndexSummary.value = await qoder.projectIndex.summary();
}

async function rebuildProjectIndex(): Promise<void> {
  projectIndexSummary.value = await qoder.projectIndex.rebuild();
  terminal.pushTerminalLine(
    `[index] ${projectIndexSummary.value.files} files / ${projectIndexSummary.value.symbols} symbols`,
    "success"
  );
}

async function searchPaletteSymbols(query: string): Promise<void> {
  const trimmed = query.trim();

  if (trimmed.length < 2) {
    paletteSymbols.value = [];
    return;
  }

  paletteSymbols.value = await qoder.projectIndex.search({
    query: trimmed,
    limit: 30
  });
}

async function openProjectSymbol(symbol: ProjectIndexSymbol): Promise<void> {
  commandPaletteVisible.value = false;
  await workspace.openSearchMatch({
    path: symbol.path,
    line: symbol.line,
    text: symbol.name
  });
}

function runPaletteCommand(commandId: string): void {
  commandPaletteVisible.value = false;

  const actions: Record<string, () => void> = {
    "file.newText": () => {
      void workspace.createTextFile();
    },
    "file.new": () => {
      void workspace.createFile();
    },
    "file.open": () => {
      void workspace.openFileFromDialog();
    },
    "file.save": () => {
      void workspace.saveSelectedFile();
    },
    "file.saveAll": () => {
      void workspace.saveAllFiles();
    },
    "terminal.show": () => {
      void showAndFocusTerminal();
    },
    "terminal.problems": () => {
      terminal.terminalVisible.value = true;
      terminal.activeTerminalTab.value = "problems";
    },
    "language.refresh": () => {
      void refreshLanguageServers();
    },
    "language.addMissingImports": () => {
      void addMissingImports();
    },
    "language.organizeImports": () => {
      void workspace.runSourceAction("source.organizeImports", "Organize Imports");
    },
    "index.rebuild": () => {
      void rebuildProjectIndex();
    }
  };

  actions[commandId]?.();
}

async function addMissingImports(): Promise<void> {
  await workspace.runSourceAction("source.addMissingImports.ts", "Add Missing Imports");
  await workspace.runSourceAction("source.addMissingImports", "Add Missing Imports");
}

async function openDiagnosticProblem(problem: DiagnosticProblem): Promise<void> {
  await workspace.openSearchMatch({
    path: problem.path,
    line: problem.line,
    text: problem.message
  });
}

function diagnosticSeverity(severity: number | undefined): DiagnosticProblem["severity"] {
  if (severity === 1) {
    return "error";
  }

  if (severity === 2) {
    return "warning";
  }

  if (severity === 3) {
    return "info";
  }

  return "hint";
}
</script>

<template>
  <div class="app-shell">
    <TitleBar
      :project-name="projectName"
      :has-current-file="Boolean(workspace.selectedFile.value)"
      :has-dirty-tabs="workspace.dirtyTabs.value.length > 0"
      :save-busy="workspace.saveBusy.value"
      :terminal-visible="terminal.terminalVisible.value"
      @open-folder="workspace.chooseFolder"
      @file-action="handleFileAction"
      @terminal-action="handleTerminalAction"
      @minimize="minimizeWindow"
      @maximize="maximizeWindow"
      @close="closeWindow"
    />

    <div class="workbench">
      <ActivityBar
        :active-activity="activeActivity"
        @select="activeActivity = $event"
      />

      <SidebarPanel
        :active-activity="activeActivity"
        :workspace-label="workspace.workspaceLabel.value"
        :load-error="workspace.loadError.value"
        :rows="workspace.visibleTreeRows.value"
        :expanded-paths="workspace.expandedPaths.value"
        :selected-file="workspace.selectedFile.value"
        :search-results="workspace.searchResults.value"
        :git-status="workspace.gitStatus.value"
        :git-diff="workspace.gitDiff.value"
        :git-branches="workspace.gitBranches.value"
        :selected-git-file="workspace.selectedGitFile.value"
        :git-busy="workspace.gitBusy.value"
        :command-busy="workspace.commandBusy.value"
        :language-servers="languageServers"
        @open-folder="workspace.chooseFolder"
        @select-row="workspace.selectTreeRow"
        @search="workspace.runSearch"
        @open-search="workspace.openSearchMatch"
        @refresh-git="workspace.refreshGitStatus"
        @open-git-diff="workspace.openGitDiff"
        @stage-git-file="workspace.stageGitFile"
        @stage-all-git-files="workspace.stageAllGitFiles"
        @unstage-git-file="workspace.unstageGitFile"
        @discard-git-file="workspace.discardGitFile"
        @commit-git-changes="workspace.commitGitChanges"
        @refresh-language-servers="refreshLanguageServers"
        @run-command="workspace.runCommand"
      />

      <main class="main-area" :class="{ 'terminal-hidden': !terminal.terminalVisible.value }">
        <EditorPane
          :open-tabs="workspace.openTabs.value"
          :selected-file="workspace.selectedFile.value"
          :breadcrumb-items="workspace.breadcrumbItems.value"
          :content="workspace.displayContent.value"
          :is-dirty="workspace.selectedFileDirty.value"
          :save-busy="workspace.saveBusy.value"
          :can-edit="Boolean(workspace.selectedFile.value)"
          @open-file="workspace.openFile"
          @close-tab="workspace.closeTab"
          @update-content="workspace.updateSelectedFileContent"
          @save-file="workspace.saveSelectedFile"
          @discard-changes="workspace.discardSelectedChanges"
          @new-file="workspace.createFile"
        />

        <TerminalPanel
          v-show="terminal.terminalVisible.value"
          ref="terminalPanelRef"
          v-model:active-tab="terminal.activeTerminalTab.value"
          :connected="Boolean(terminal.terminalSessionId.value)"
          :output-lines="terminal.terminalLines.value"
          :problems="diagnosticProblems"
          :shell-label="terminalShellLabel"
          @ready="handleTerminalReady"
          @input="handleTerminalInput"
          @resize="handleTerminalResize"
          @clear="terminal.clearTerminal"
          @new-terminal="restartPtyTerminal"
          @open-problem="openDiagnosticProblem"
          @close="terminal.hideTerminal"
        />
      </main>

    </div>

    <StatusBar
      :status-text="statusText"
      :language-mode="workspace.languageMode.value"
    />

    <CommandPalette
      :visible="commandPaletteVisible"
      :commands="paletteCommands"
      :symbols="paletteSymbols"
      @close="commandPaletteVisible = false"
      @run="runPaletteCommand"
      @open-symbol="openProjectSymbol"
      @search-symbols="searchPaletteSymbols"
    />
  </div>
</template>
