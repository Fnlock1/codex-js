import type {
  GitStatusSummary,
  ProjectIndexSummary,
  ProjectIndexSymbol
} from "@qoder-open/shared";
import type { QoderDesktopApi } from "../../../preload";
import type { WorkspaceEntry, WorkspaceSnapshot } from "../types";

export function createPreviewApi(): QoderDesktopApi {
  const terminalDataListeners = new Set<(payload: { sessionId: string; data: string }) => void>();
  const terminalExitListeners = new Set<(payload: { sessionId: string; exitCode: number }) => void>();
  const languageStatusListeners = new Set<Parameters<QoderDesktopApi["language"]["onStatusChanged"]>[0]>();
  const diagnosticsListeners = new Set<Parameters<QoderDesktopApi["language"]["onDiagnostics"]>[0]>();
  const snapshot = createPreviewSnapshot();
  const previewFiles = new Map<string, string>();

  return {
    workspace: {
      get: async () => snapshot,
      openFolder: async () => snapshot,
      openFileDialog: async () => ({
        snapshot,
        filePath: "README.md"
      }),
      readFile: async (filePath: string) => ({
        path: filePath,
        content: previewFiles.get(filePath) ?? previewContent(filePath)
      }),
      writeFile: async ({ path, content }) => {
        previewFiles.set(path, content);
        return {
          path,
          bytes: new Blob([content]).size
        };
      },
      saveFileAs: async ({ suggestedPath, content }) => {
        const path = suggestedPath?.trim() || "untitled.txt";
        previewFiles.set(path, content);
        return {
          snapshot,
          path,
          bytes: new Blob([content]).size
        };
      },
      reveal: async () => undefined,
      search: async ({ query }) =>
        snapshot.files
          .filter((entry) => entry.kind === "file" && entry.path.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 20)
          .map((entry) => ({
            path: entry.path,
            line: 1,
            text: `Preview match for ${query}`
          })),
      gitStatus: async () => previewGitStatus(),
      gitDiff: async (filePath) => ({
        path: filePath,
        staged: "",
        unstaged: [
          `diff --git a/${filePath} b/${filePath}`,
          `--- a/${filePath}`,
          `+++ b/${filePath}`,
          "@@",
          "-export const preview = false",
          "+export const preview = true"
        ].join("\n")
      }),
      gitStage: async () => previewGitStatus(),
      gitStageAll: async () => previewGitStatus(),
      gitUnstage: async () => previewGitStatus(),
      gitDiscard: async () => previewGitStatus(),
      gitCommit: async (message) => ({
        ok: true,
        output: `[preview abc1234] ${message}`,
        commit: "abc1234"
      }),
      gitBranches: async () => [
        {
          name: "main",
          current: true
        },
        {
          name: "feature/ide-workbench",
          current: false
        }
      ]
    },
    terminal: {
      run: async ({ command }) => ({
        ok: true,
        output: `Preview command completed: ${command}`,
        exitCode: 0
      }),
      create: async ({ cwd }) => {
        const sessionId = createId();
        window.setTimeout(() => {
          terminalDataListeners.forEach((listener) => {
            listener({
              sessionId,
              data: `Qoder preview PTY\r\nPS ${cwd || snapshot.cwd}> `
            });
          });
        }, 50);

        return {
          sessionId,
          shell: "preview-powershell",
          cwd: cwd || snapshot.cwd
        };
      },
      write: async ({ sessionId, data }) => {
        terminalDataListeners.forEach((listener) => {
          listener({
            sessionId,
            data
          });
        });
      },
      resize: async () => undefined,
      dispose: async (sessionId) => {
        terminalExitListeners.forEach((listener) => {
          listener({
            sessionId,
            exitCode: 0
          });
        });
      },
      onData: (callback) => {
        terminalDataListeners.add(callback);
        return () => terminalDataListeners.delete(callback);
      },
      onExit: (callback) => {
        terminalExitListeners.add(callback);
        return () => terminalExitListeners.delete(callback);
      }
    },
    language: {
      status: async () => [
        {
          languageId: "vue",
          label: "Vue / language-tools",
          available: false,
          state: "missing",
          command: "preview",
          detail: "Language servers are available in the Electron desktop runtime."
        },
        {
          languageId: "python",
          label: "Python / Pyright",
          available: false,
          state: "missing",
          command: "preview",
          detail: "Language servers are available in the Electron desktop runtime."
        },
        {
          languageId: "rust",
          label: "Rust / rust-analyzer",
          available: false,
          state: "missing",
          command: "preview",
          detail: "Language servers are available in the Electron desktop runtime."
        },
        {
          languageId: "go",
          label: "Go / gopls",
          available: false,
          state: "missing",
          command: "preview",
          detail: "Language servers are available in the Electron desktop runtime."
        }
      ],
      syncDocument: async () => undefined,
      didSaveDocument: async () => undefined,
      didChangeFiles: async () => undefined,
      completions: async () => ({
        source: "unavailable",
        message: "Preview runtime does not run language servers.",
        items: []
      }),
      resolveCompletion: async ({ item }) => item,
      hover: async () => null,
      definition: async () => [],
      references: async () => [],
      codeActions: async () => [],
      resolveCodeAction: async ({ action }) => action,
      executeCommand: async () => ({
        workspaceEdits: []
      }),
      rename: async () => null,
      format: async () => [],
      semanticTokens: async () => null,
      onDiagnostics: (callback) => {
        diagnosticsListeners.add(callback);
        return () => diagnosticsListeners.delete(callback);
      },
      onStatusChanged: (callback) => {
        languageStatusListeners.add(callback);
        return () => languageStatusListeners.delete(callback);
      }
    },
    projectIndex: {
      summary: async () => previewIndexSummary(snapshot),
      rebuild: async () => previewIndexSummary(snapshot),
      search: async ({ query, limit }) =>
        previewIndexSymbols(snapshot)
          .filter((symbol) => symbol.name.toLowerCase().includes(query.toLowerCase()))
          .slice(0, limit ?? 50)
    },
    window: {
      minimize: async () => undefined,
      maximize: async () => undefined,
      close: async () => undefined
    }
  };
}

function createPreviewSnapshot(): WorkspaceSnapshot {
  const filePaths = [
    "apps/desktop/src/main/index.ts",
    "apps/desktop/src/main/workspace-service.ts",
    "apps/desktop/src/preload/index.ts",
    "apps/desktop/src/renderer/src/App.vue",
    "apps/desktop/src/renderer/src/components/SidebarPanel.vue",
    "packages/shared/src/index.ts",
    "package.json",
    "README.md"
  ];
  const dirs = new Set<string>();

  for (const filePath of filePaths) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      dirs.add(parts.slice(0, index).join("/"));
    }
  }

  return {
    cwd: "F:\\接单\\qoder开源版本",
    name: "qoder-open",
    files: [
      ...Array.from(dirs).map<WorkspaceEntry>((path) => ({ path, kind: "directory" })),
      ...filePaths.map<WorkspaceEntry>((path) => ({ path, kind: "file" }))
    ]
  };
}

function previewContent(filePath: string): string {
  if (filePath.endsWith("package.json")) {
    return '{\n  "name": "qoder-open",\n  "scripts": {\n    "check": "pnpm -r check",\n    "test": "pnpm -r test"\n  }\n}\n';
  }

  return [
    "export function previewFeature() {",
    '  return "Qoder Open workspace tools are connected";',
    "}",
    "",
    "// Use the real Electron build to run commands, search files, and inspect Git status."
  ].join("\n");
}

function previewGitStatus(): GitStatusSummary {
  return {
    branch: "main",
    clean: false,
    files: [
      {
        index: "M",
        workingTree: " ",
        path: "apps/desktop/src/renderer/src/App.vue"
      },
      {
        index: "?",
        workingTree: "?",
        path: "apps/desktop/src/renderer/src/components/SidebarPanel.vue"
      }
    ],
    raw: "## main\nM  apps/desktop/src/renderer/src/App.vue\n?? apps/desktop/src/renderer/src/components/SidebarPanel.vue"
  };
}

function previewIndexSummary(snapshot: WorkspaceSnapshot): ProjectIndexSummary {
  const symbols = previewIndexSymbols(snapshot);

  return {
    workspace: snapshot.cwd,
    indexedAt: Date.now(),
    files: snapshot.files.filter((entry) => entry.kind === "file").length,
    symbols: symbols.length,
    languages: {
      typescript: 4,
      vue: 1,
      markdown: 1
    },
    projectFiles: ["package.json", "tsconfig.json"]
  };
}

function previewIndexSymbols(snapshot: WorkspaceSnapshot): ProjectIndexSymbol[] {
  return [
    {
      name: "previewFeature",
      kind: "function",
      path: "apps/desktop/src/renderer/src/App.vue",
      line: 1,
      column: 16,
      languageId: "vue"
    },
    {
      name: "WorkspaceService",
      kind: "class",
      path: "apps/desktop/src/main/workspace-service.ts",
      line: 1,
      column: 14,
      languageId: "typescript"
    },
    {
      name: snapshot.name,
      kind: "module",
      path: "package.json",
      line: 1,
      column: 1,
      languageId: "json"
    }
  ];
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}
