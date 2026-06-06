import { contextBridge, ipcRenderer } from "electron";
import type {
  CodeActionRequest,
  CodeActionResolveRequest,
  CodeActionResult,
  CodeDefinitionRequest,
  CodeDiagnostic,
  CodeDiagnosticsEvent,
  CodeDocumentRequest,
  CodeDocumentSaveRequest,
  CodeExecuteCommandRequest,
  CodeExecuteCommandResult,
  CodeFileEvent,
  CodeFormatRequest,
  CodeHoverRequest,
  CodeHoverResult,
  CodeLocation,
  CodeCompletionRequest,
  CodeCompletionResolveRequest,
  CodeCompletionResult,
  CodeCompletionItem,
  CodeCompletionTextEdit,
  CodeRenameRequest,
  CodeReferencesRequest,
  CodeSemanticTokens,
  CodeSemanticTokensRequest,
  CodeWorkspaceEdit,
  GitBranch,
  GitCommitResult,
  GitFileDiff,
  GitStatusSummary,
  LanguageServerStatus,
  ProjectIndexSearchRequest,
  ProjectIndexSummary,
  ProjectIndexSymbol,
  ShellCommandResult,
  WorkspaceSearchMatch
} from "@qoder-open/shared";

export interface WorkspaceEntry {
  path: string;
  kind: "file" | "directory";
}

export interface WorkspaceSnapshot {
  cwd: string;
  name: string;
  files: WorkspaceEntry[];
}

export interface ReadFileResult {
  path: string;
  content: string;
}

export interface WriteFilePayload {
  path: string;
  content: string;
}

export interface WriteFileResult {
  path: string;
  bytes: number;
}

export interface OpenFileDialogResult {
  snapshot: WorkspaceSnapshot;
  filePath?: string;
}

export interface SaveFileAsPayload {
  suggestedPath?: string;
  content: string;
}

export interface SaveFileAsResult {
  snapshot: WorkspaceSnapshot;
  path: string;
  bytes: number;
}

export interface TerminalCreatePayload {
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalCreateResult {
  sessionId: string;
  shell: string;
  cwd: string;
}

export interface TerminalWritePayload {
  sessionId: string;
  data: string;
}

export interface TerminalResizePayload {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalDataEvent {
  sessionId: string;
  data: string;
}

export interface TerminalExitEvent {
  sessionId: string;
  exitCode: number;
}

const api = {
  workspace: {
    get: () => ipcRenderer.invoke("workspace:get") as Promise<WorkspaceSnapshot>,
    openFolder: () => ipcRenderer.invoke("workspace:openFolder") as Promise<WorkspaceSnapshot>,
    openFileDialog: () =>
      ipcRenderer.invoke("workspace:openFileDialog") as Promise<OpenFileDialogResult>,
    readFile: (filePath: string) =>
      ipcRenderer.invoke("workspace:readFile", filePath) as Promise<ReadFileResult>,
    writeFile: (payload: WriteFilePayload) =>
      ipcRenderer.invoke("workspace:writeFile", payload) as Promise<WriteFileResult>,
    saveFileAs: (payload: SaveFileAsPayload) =>
      ipcRenderer.invoke("workspace:saveFileAs", payload) as Promise<SaveFileAsResult | null>,
    reveal: (filePath: string) => ipcRenderer.invoke("workspace:reveal", filePath) as Promise<void>,
    search: (payload: { query: string; glob?: string }) =>
      ipcRenderer.invoke("workspace:search", payload) as Promise<WorkspaceSearchMatch[]>,
    gitStatus: () => ipcRenderer.invoke("workspace:gitStatus") as Promise<GitStatusSummary>,
    gitDiff: (filePath: string) =>
      ipcRenderer.invoke("workspace:gitDiff", filePath) as Promise<GitFileDiff>,
    gitStage: (filePath: string) =>
      ipcRenderer.invoke("workspace:gitStage", filePath) as Promise<GitStatusSummary>,
    gitStageAll: () => ipcRenderer.invoke("workspace:gitStageAll") as Promise<GitStatusSummary>,
    gitUnstage: (filePath: string) =>
      ipcRenderer.invoke("workspace:gitUnstage", filePath) as Promise<GitStatusSummary>,
    gitDiscard: (filePath: string) =>
      ipcRenderer.invoke("workspace:gitDiscard", filePath) as Promise<GitStatusSummary>,
    gitCommit: (message: string) =>
      ipcRenderer.invoke("workspace:gitCommit", message) as Promise<GitCommitResult>,
    gitBranches: () => ipcRenderer.invoke("workspace:gitBranches") as Promise<GitBranch[]>
  },
  terminal: {
    run: (payload: { command: string }) =>
      ipcRenderer.invoke("terminal:run", payload) as Promise<ShellCommandResult>,
    create: (payload: TerminalCreatePayload) =>
      ipcRenderer.invoke("terminal:create", payload) as Promise<TerminalCreateResult>,
    write: (payload: TerminalWritePayload) =>
      ipcRenderer.invoke("terminal:write", payload) as Promise<void>,
    resize: (payload: TerminalResizePayload) =>
      ipcRenderer.invoke("terminal:resize", payload) as Promise<void>,
    dispose: (sessionId: string) => ipcRenderer.invoke("terminal:dispose", sessionId) as Promise<void>,
    onData: (callback: (payload: TerminalDataEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent) => callback(payload);
      ipcRenderer.on("terminal:data", handler);
      return () => {
        ipcRenderer.removeListener("terminal:data", handler);
      };
    },
    onExit: (callback: (payload: TerminalExitEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: TerminalExitEvent) => callback(payload);
      ipcRenderer.on("terminal:exit", handler);
      return () => {
        ipcRenderer.removeListener("terminal:exit", handler);
      };
    }
  },
  language: {
    status: () => ipcRenderer.invoke("language:status") as Promise<LanguageServerStatus[]>,
    syncDocument: (payload: CodeDocumentRequest) =>
      ipcRenderer.invoke("language:syncDocument", payload) as Promise<void>,
    didSaveDocument: (payload: CodeDocumentSaveRequest) =>
      ipcRenderer.invoke("language:didSaveDocument", payload) as Promise<void>,
    didChangeFiles: (payload: CodeFileEvent[]) =>
      ipcRenderer.invoke("language:didChangeFiles", payload) as Promise<void>,
    completions: (payload: CodeCompletionRequest) =>
      ipcRenderer.invoke("language:completions", payload) as Promise<CodeCompletionResult>,
    resolveCompletion: (payload: CodeCompletionResolveRequest) =>
      ipcRenderer.invoke("language:resolveCompletion", payload) as Promise<CodeCompletionItem>,
    hover: (payload: CodeHoverRequest) =>
      ipcRenderer.invoke("language:hover", payload) as Promise<CodeHoverResult | null>,
    definition: (payload: CodeDefinitionRequest) =>
      ipcRenderer.invoke("language:definition", payload) as Promise<CodeLocation[]>,
    references: (payload: CodeReferencesRequest) =>
      ipcRenderer.invoke("language:references", payload) as Promise<CodeLocation[]>,
    codeActions: (payload: CodeActionRequest) =>
      ipcRenderer.invoke("language:codeActions", payload) as Promise<CodeActionResult[]>,
    resolveCodeAction: (payload: CodeActionResolveRequest) =>
      ipcRenderer.invoke("language:resolveCodeAction", payload) as Promise<CodeActionResult>,
    executeCommand: (payload: CodeExecuteCommandRequest) =>
      ipcRenderer.invoke("language:executeCommand", payload) as Promise<CodeExecuteCommandResult>,
    rename: (payload: CodeRenameRequest) =>
      ipcRenderer.invoke("language:rename", payload) as Promise<CodeWorkspaceEdit | null>,
    format: (payload: CodeFormatRequest) =>
      ipcRenderer.invoke("language:format", payload) as Promise<CodeCompletionTextEdit[]>,
    semanticTokens: (payload: CodeSemanticTokensRequest) =>
      ipcRenderer.invoke("language:semanticTokens", payload) as Promise<CodeSemanticTokens | null>,
    onDiagnostics: (callback: (payload: CodeDiagnosticsEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: CodeDiagnosticsEvent) =>
        callback(payload);
      ipcRenderer.on("language:diagnostics", handler);
      return () => {
        ipcRenderer.removeListener("language:diagnostics", handler);
      };
    },
    onStatusChanged: (callback: (payload: LanguageServerStatus[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: LanguageServerStatus[]) =>
        callback(payload);
      ipcRenderer.on("language:statusChanged", handler);
      return () => {
        ipcRenderer.removeListener("language:statusChanged", handler);
      };
    }
  },
  projectIndex: {
    summary: () => ipcRenderer.invoke("projectIndex:summary") as Promise<ProjectIndexSummary>,
    rebuild: () => ipcRenderer.invoke("projectIndex:rebuild") as Promise<ProjectIndexSummary>,
    search: (payload: ProjectIndexSearchRequest) =>
      ipcRenderer.invoke("projectIndex:search", payload) as Promise<ProjectIndexSymbol[]>
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize") as Promise<void>,
    maximize: () => ipcRenderer.invoke("window:maximize") as Promise<void>,
    close: () => ipcRenderer.invoke("window:close") as Promise<void>
  }
};

contextBridge.exposeInMainWorld("qoder", api);

export type QoderDesktopApi = typeof api;
