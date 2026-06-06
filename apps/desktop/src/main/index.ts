import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import type { OpenDialogOptions, SaveDialogOptions } from "electron";
import { config } from "dotenv";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type {
  CodeActionRequest,
  CodeActionResolveRequest,
  CodeDefinitionRequest,
  CodeDocumentRequest,
  CodeDocumentSaveRequest,
  CodeExecuteCommandRequest,
  CodeFileEvent,
  CodeFormatRequest,
  CodeHoverRequest,
  CodeCompletionRequest,
  CodeCompletionResolveRequest,
  CodeRenameRequest,
  CodeReferencesRequest,
  CodeSemanticTokensRequest,
} from "@qoder-open/shared";
import { LanguageServiceManager } from "./language-service.js";
import { ProjectIndexService } from "./project-index-service.js";
import { WorkspaceService } from "./workspace-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | undefined;
const workspaceService = new WorkspaceService(
  process.env.QODER_WORKSPACE ?? process.env.INIT_CWD ?? process.cwd()
);
const languageServiceManager = new LanguageServiceManager(workspaceService, __dirname);
const projectIndexService = new ProjectIndexService(workspaceService);
const terminalSessions = new Map<string, IPty>();

loadEnvironmentForWorkspace(workspaceService.cwd);

languageServiceManager.onDiagnostics((payload) => {
  safeSend("language:diagnostics", payload);
});

languageServiceManager.onStatusChanged((payload) => {
  safeSend("language:statusChanged", payload);
});

function sendTerminalData(sessionId: string, data: string): void {
  safeSend("terminal:data", { sessionId, data });
}

function sendTerminalExit(sessionId: string, exitCode: number): void {
  safeSend("terminal:exit", { sessionId, exitCode });
}

function safeSend(channel: string, payload: unknown): void {
  const window = mainWindow;

  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return;
  }

  try {
    window.webContents.send(channel, payload);
  } catch {
    // Renderer teardown races are expected during window close and app quit.
  }
}

function loadEnvironmentForWorkspace(cwd: string): void {
  for (const envFile of findEnvFiles(cwd)) {
    config({ path: envFile, override: true });
  }

  config();
}

function findEnvFiles(cwd: string): string[] {
  const envFiles: string[] = [];
  let current = resolve(cwd);
  let previous = "";

  while (current !== previous) {
    const envFile = join(current, ".env");

    if (existsSync(envFile)) {
      envFiles.push(envFile);
    }

    previous = current;
    current = dirname(current);
  }

  return envFiles.reverse();
}

function cleanupTerminalSessions(): void {
  for (const [sessionId, terminal] of terminalSessions) {
    terminalSessions.delete(sessionId);

    try {
      terminal.kill();
    } catch {
      // The PTY may already be gone; shutdown should stay best-effort.
    }
  }
}

function cleanupLanguageServices(): void {
  languageServiceManager.dispose();
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    frame: false,
    backgroundColor: "#111312",
    title: "Qoder Open Desktop",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false
    }
  });
  mainWindow = window;

  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) {
      window.show();
    }
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }

    cleanupTerminalSessions();
    cleanupLanguageServices();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("window:minimize", () => {
  mainWindow?.minimize();
});

ipcMain.handle("window:maximize", () => {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return;
  }

  mainWindow.maximize();
});

ipcMain.handle("window:close", () => {
  mainWindow?.close();
});

ipcMain.handle("workspace:get", async () => workspaceService.snapshot());

ipcMain.handle("workspace:openFolder", async () => {
  const options: OpenDialogOptions = {
    properties: ["openDirectory"],
    title: "选择工作区"
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) {
    return workspaceService.snapshot();
  }

  workspaceService.setWorkspace(result.filePaths[0]);
  languageServiceManager.workspaceChanged();
  projectIndexService.reset();
  void projectIndexService.rebuild();
  loadEnvironmentForWorkspace(workspaceService.cwd);
  return workspaceService.snapshot();
});

ipcMain.handle("workspace:openFileDialog", async () => {
  const options: OpenDialogOptions = {
    properties: ["openFile"],
    title: "打开文件"
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) {
    return {
      snapshot: await workspaceService.snapshot()
    };
  }

  const selectedPath = result.filePaths[0];

  if (workspaceService.isInsideWorkspace(selectedPath)) {
    return {
      snapshot: await workspaceService.snapshot(),
      filePath: workspaceService.toWorkspaceRelativePath(selectedPath)
    };
  }

  const opened = await workspaceService.openExternalFileAsWorkspace(selectedPath);
  languageServiceManager.workspaceChanged();
  projectIndexService.reset();
  void projectIndexService.rebuild();
  loadEnvironmentForWorkspace(workspaceService.cwd);
  return opened;
});

ipcMain.handle("workspace:readFile", async (_event, filePath: string) => {
  return workspaceService.readFile(filePath);
});

ipcMain.handle("workspace:writeFile", async (_event, payload: { path: string; content: string }) => {
  const existed = existsSync(workspaceService.resolveInsideWorkspace(payload.path));
  const result = await workspaceService.writeFile(payload.path, payload.content);
  await languageServiceManager.didChangeFiles([
    {
      path: result.path,
      type: existed ? "changed" : "created"
    }
  ]);
  await projectIndexService.didChangeFiles([
    {
      path: result.path,
      type: existed ? "changed" : "created"
    }
  ]);
  return result;
});

ipcMain.handle(
  "workspace:saveFileAs",
  async (_event, payload: { suggestedPath?: string; content: string }) => {
    const options: SaveDialogOptions = {
      title: "另存为",
      defaultPath: payload.suggestedPath
        ? workspaceService.resolveInsideWorkspace(payload.suggestedPath)
        : workspaceService.cwd
    };
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      return null;
    }

    const previousWorkspace = workspaceService.cwd;
    const existed = existsSync(result.filePath);
    const saved = await workspaceService.saveFileAsAbsolute(result.filePath, payload.content);

    if (workspaceService.cwd !== previousWorkspace) {
      languageServiceManager.workspaceChanged();
      projectIndexService.reset();
    }

    await languageServiceManager.didChangeFiles([
      {
        path: saved.path,
        type: existed ? "changed" : "created"
      }
    ]);
    await projectIndexService.didChangeFiles([
      {
        path: saved.path,
        type: existed ? "changed" : "created"
      }
    ]);
    loadEnvironmentForWorkspace(workspaceService.cwd);

    return {
      snapshot: await workspaceService.snapshot(),
      path: saved.path,
      bytes: saved.bytes
    };
  }
);

ipcMain.handle("workspace:reveal", async (_event, filePath: string) => {
  const resolved = workspaceService.resolveInsideWorkspace(filePath);
  shell.showItemInFolder(resolved);
});

ipcMain.handle("workspace:search", async (_event, payload: { query: string; glob?: string }) => {
  return workspaceService.search(payload.query, payload.glob);
});

ipcMain.handle("workspace:gitStatus", async () => {
  return workspaceService.gitStatus();
});

ipcMain.handle("workspace:gitDiff", async (_event, filePath: string) => {
  return workspaceService.gitDiff(filePath);
});

ipcMain.handle("workspace:gitStage", async (_event, filePath: string) => {
  return workspaceService.gitStage(filePath);
});

ipcMain.handle("workspace:gitStageAll", async () => {
  return workspaceService.gitStageAll();
});

ipcMain.handle("workspace:gitUnstage", async (_event, filePath: string) => {
  return workspaceService.gitUnstage(filePath);
});

ipcMain.handle("workspace:gitDiscard", async (_event, filePath: string) => {
  const status = await workspaceService.gitDiscard(filePath);
  const normalizedPath = filePath.replace(/\\/g, "/");
  await languageServiceManager.didChangeFiles([
    {
      path: normalizedPath,
      type: "changed"
    }
  ]);
  await projectIndexService.didChangeFiles([
    {
      path: normalizedPath,
      type: "changed"
    }
  ]);
  return status;
});

ipcMain.handle("workspace:gitCommit", async (_event, message: string) => {
  return workspaceService.gitCommit(message);
});

ipcMain.handle("workspace:gitBranches", async () => {
  return workspaceService.gitBranches();
});

ipcMain.handle("terminal:run", async (_event, payload: { command: string }) => {
  return workspaceService.runCommand(payload.command);
});

ipcMain.handle(
  "terminal:create",
  (_event, payload: { cwd?: string; cols?: number; rows?: number } = {}) => {
    const sessionId = randomUUID();
    const cwd = payload.cwd?.trim() || workspaceService.cwd;
    const cols = clampTerminalDimension(payload.cols, 80);
    const rows = clampTerminalDimension(payload.rows, 24);
    const shellPath = getTerminalShell();
    const shellArgs = getTerminalShellArgs();
    let terminal: IPty;

    try {
      terminal = pty.spawn(shellPath, shellArgs, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: terminalEnv()
      });
    } catch (error) {
      throw new Error(`Failed to create terminal: ${error instanceof Error ? error.message : String(error)}`);
    }

    terminalSessions.set(sessionId, terminal);

    terminal.onData((data) => {
      if (terminalSessions.get(sessionId) === terminal) {
        sendTerminalData(sessionId, data);
      }
    });

    terminal.onExit(({ exitCode }) => {
      if (terminalSessions.get(sessionId) === terminal) {
        terminalSessions.delete(sessionId);
        sendTerminalExit(sessionId, exitCode);
      }
    });

    return {
      sessionId,
      shell: shellPath,
      cwd
    };
  }
);

ipcMain.handle("terminal:write", (_event, payload: { sessionId: string; data: string }) => {
  const terminal = terminalSessions.get(payload.sessionId);

  if (!terminal) {
    return;
  }

  try {
    terminal.write(payload.data);
  } catch {
    terminalSessions.delete(payload.sessionId);
  }
});

ipcMain.handle(
  "terminal:resize",
  (_event, payload: { sessionId: string; cols: number; rows: number }) => {
    const terminal = terminalSessions.get(payload.sessionId);

    if (!terminal) {
      return;
    }

    try {
      terminal.resize(clampTerminalDimension(payload.cols, 80), clampTerminalDimension(payload.rows, 24));
    } catch {
      terminalSessions.delete(payload.sessionId);
    }
  }
);

ipcMain.handle("terminal:dispose", (_event, sessionId: string) => {
  const terminal = terminalSessions.get(sessionId);
  terminalSessions.delete(sessionId);

  try {
    terminal?.kill();
  } catch {
    // Terminal disposal is best-effort.
  }
});

ipcMain.handle("language:status", () => {
  return languageServiceManager.status();
});

ipcMain.handle("language:syncDocument", async (_event, payload: CodeDocumentRequest) => {
  await languageServiceManager.syncDocument(payload);
});

ipcMain.handle("language:didSaveDocument", async (_event, payload: CodeDocumentSaveRequest) => {
  await languageServiceManager.didSaveDocument(payload);
});

ipcMain.handle("language:didChangeFiles", async (_event, payload: CodeFileEvent[]) => {
  await languageServiceManager.didChangeFiles(payload);
});

ipcMain.handle("language:completions", async (_event, payload: CodeCompletionRequest) => {
  return languageServiceManager.completions(payload);
});

ipcMain.handle("language:resolveCompletion", async (_event, payload: CodeCompletionResolveRequest) => {
  return languageServiceManager.resolveCompletion(payload);
});

ipcMain.handle("language:hover", async (_event, payload: CodeHoverRequest) => {
  return languageServiceManager.hover(payload);
});

ipcMain.handle("language:definition", async (_event, payload: CodeDefinitionRequest) => {
  return languageServiceManager.definition(payload);
});

ipcMain.handle("language:references", async (_event, payload: CodeReferencesRequest) => {
  return languageServiceManager.references(payload);
});

ipcMain.handle("language:codeActions", async (_event, payload: CodeActionRequest) => {
  return languageServiceManager.codeActions(payload);
});

ipcMain.handle("language:resolveCodeAction", async (_event, payload: CodeActionResolveRequest) => {
  return languageServiceManager.resolveCodeAction(payload);
});

ipcMain.handle("language:executeCommand", async (_event, payload: CodeExecuteCommandRequest) => {
  return languageServiceManager.executeCommand(payload);
});

ipcMain.handle("language:rename", async (_event, payload: CodeRenameRequest) => {
  return languageServiceManager.rename(payload);
});

ipcMain.handle("language:format", async (_event, payload: CodeFormatRequest) => {
  return languageServiceManager.format(payload);
});

ipcMain.handle("language:semanticTokens", async (_event, payload: CodeSemanticTokensRequest) => {
  return languageServiceManager.semanticTokens(payload);
});

ipcMain.handle("projectIndex:summary", async () => {
  return projectIndexService.summary();
});

ipcMain.handle("projectIndex:rebuild", async () => {
  return projectIndexService.rebuild();
});

ipcMain.handle("projectIndex:search", async (_event, payload: { query: string; limit?: number }) => {
  return projectIndexService.search(payload);
});

function getTerminalShell(): string {
  if (process.env.QODER_TERMINAL_SHELL?.trim()) {
    return process.env.QODER_TERMINAL_SHELL.trim();
  }

  if (process.platform === "win32") {
    return join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
  }

  return process.env.SHELL || "/bin/sh";
}

function getTerminalShellArgs(): string[] {
  if (process.env.QODER_TERMINAL_SHELL_ARGS?.trim()) {
    return process.env.QODER_TERMINAL_SHELL_ARGS.split(" ").filter(Boolean);
  }

  if (process.platform === "win32") {
    return [
      "-NoLogo",
      "-NoExit",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [Console]::OutputEncoding"
    ];
  }

  return [];
}

function terminalEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  env.TERM = env.TERM || "xterm-256color";
  env.COLORTERM = env.COLORTERM || "truecolor";
  env.FORCE_COLOR = env.FORCE_COLOR || "1";
  env.PYTHONIOENCODING = env.PYTHONIOENCODING || "utf-8";

  return env;
}

function clampTerminalDimension(value: number | undefined, fallback: number): number {
  const nextValue = Number(value);

  if (!Number.isFinite(nextValue)) {
    return fallback;
  }

  return Math.max(2, Math.floor(nextValue));
}
