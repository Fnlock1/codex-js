import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface TsServerMessage {
  type?: "request" | "response" | "event";
  seq?: number;
  request_seq?: number;
  command?: string;
  success?: boolean;
  message?: string;
  body?: unknown;
}

interface PendingRequest {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface VueTsServerBridgeOptions {
  nodeExecutable: string;
  tsserverPath: string;
  pluginProbeLocation: string;
  workspacePath: string;
}

export type VueDocumentContentProvider = (filePath: string) => string | undefined;

const configureTimeoutMs = 5_000;
const openTimeoutMs = 4_000;
const projectInfoTimeoutMs = 4_000;
const vueRequestTimeoutMs = 1_200;
const cacheTtlMs = 5_000;

const cacheableCommands = new Set([
  "_vue:projectInfo",
  "_vue:getComponentDirectives",
  "_vue:getComponentNames",
  "_vue:getComponentSlots",
  "_vue:getElementAttrs",
  "_vue:getElementNames"
]);

export class VueTsServerBridge {
  private process: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private nextSeq = 1;
  private configured = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly openedDocuments = new Map<string, string>();
  private readonly responseCache = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly options: VueTsServerBridgeOptions) {}

  async forward(
    command: string,
    args: unknown,
    contentProvider: VueDocumentContentProvider
  ): Promise<unknown> {
    await this.ensureStarted();

    const filePath = tsServerRequestFile(args);

    if (filePath) {
      await this.ensureDocumentOpen(filePath, contentProvider(filePath));
    }

    const cacheKey = this.cacheKey(command, args);

    if (cacheKey) {
      const cached = this.responseCache.get(cacheKey);

      if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
      }
    }

    const value = await this.request(
      command,
      args,
      command === "_vue:projectInfo" ? projectInfoTimeoutMs : vueRequestTimeoutMs
    );

    if (cacheKey) {
      this.responseCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + cacheTtlMs
      });
    }

    return value;
  }

  dispose(): void {
    try {
      this.process?.kill();
    } catch {
      // Shutdown is best-effort.
    }

    this.process = undefined;
    this.configured = false;
    this.openedDocuments.clear();
    this.responseCache.clear();
    this.rejectAllPending("Vue tsserver bridge disposed.");
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && this.configured) {
      return;
    }

    if (!existsSync(this.options.tsserverPath)) {
      throw new Error(`TypeScript server was not found at ${this.options.tsserverPath}.`);
    }

    this.startProcess();
    await this.request(
      "configure",
      {
        preferences: {
          includeCompletionsForImportStatements: true,
          includeCompletionsForModuleExports: true,
          includePackageJsonAutoImports: "auto",
          importModuleSpecifierPreference: "shortest"
        },
        hostInfo: "qoder-open-desktop",
        extraFileExtensions: [
          {
            extension: ".vue",
            scriptKindName: "Deferred",
            isMixedContent: true
          }
        ]
      },
      configureTimeoutMs
    );
    this.configured = true;
  }

  private startProcess(): void {
    this.dispose();
    const child = spawn(
      this.options.nodeExecutable,
      [
        this.options.tsserverPath,
        "--globalPlugins",
        "@vue/typescript-plugin",
        "--pluginProbeLocations",
        this.options.pluginProbeLocation,
        "--allowLocalPluginLoads"
      ],
      {
        cwd: this.options.workspacePath,
        env: process.env,
        windowsHide: true
      }
    );
    this.process = child;
    child.stdout.on("data", (chunk) => this.handleData(chunk));
    child.stdout.on("error", (error) => this.handleProcessFailure(`Vue tsserver bridge stdout failed: ${error.message}.`, child));
    child.stdin.on("error", (error) => this.handleProcessFailure(`Vue tsserver bridge input pipe closed: ${error.message}.`, child));
    child.stderr.on("data", () => undefined);
    child.stderr.on("error", () => undefined);
    child.on("exit", () => {
      this.handleProcessFailure("Vue tsserver bridge exited.", child, false);
    });
    child.on("error", (error) => {
      this.handleProcessFailure(error.message, child, false);
    });
  }

  private async ensureDocumentOpen(filePath: string, content: string | undefined): Promise<void> {
    const normalizedFilePath = normalizeFilePath(filePath);
    const nextContent = content ?? readFileContent(normalizedFilePath);

    if (nextContent === undefined) {
      return;
    }

    const existingContent = this.openedDocuments.get(normalizedFilePath);

    if (existingContent === nextContent) {
      return;
    }

    if (existingContent === undefined) {
      await this.request(
        "open",
        {
          file: normalizedFilePath,
          fileContent: nextContent,
          scriptKindName: "Deferred",
          projectRootPath: normalizeFilePath(this.options.workspacePath)
        },
        openTimeoutMs
      );
    } else {
      await this.request(
        "change",
        {
          file: normalizedFilePath,
          ...fullTextChange(existingContent, nextContent)
        },
        openTimeoutMs
      );
    }

    this.openedDocuments.set(normalizedFilePath, nextContent);
    this.responseCache.clear();
  }

  private request(command: string, args: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.process;

    if (!child) {
      throw new Error("Vue tsserver bridge is not running.");
    }

    if (child.stdin.destroyed || child.stdin.writableEnded || !child.stdin.writable) {
      const error = new Error("Vue tsserver bridge input pipe is closed.");
      this.handleProcessFailure(error.message, child);
      throw error;
    }

    const seq = this.nextSeq++;
    const message = {
      seq,
      type: "request",
      command,
      arguments: args
    };

    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        rejectRequest(new Error(`Vue tsserver bridge timed out on ${command}.`));
      }, timeoutMs);
      this.pending.set(seq, {
        command,
        resolve: resolveRequest,
        reject: rejectRequest,
        timer
      });

      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, "utf8", (error) => {
          if (!error) {
            return;
          }

          this.rejectPendingRequest(seq, error);
          this.handleProcessFailure(`Vue tsserver bridge input pipe failed: ${error.message}.`, child);
        });
      } catch (error) {
        const writeError = toError(error);
        this.rejectPendingRequest(seq, writeError);
        this.handleProcessFailure(`Vue tsserver bridge input pipe failed: ${writeError.message}.`, child);
      }
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");

      if (headerEnd < 0) {
        return;
      }

      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(header);

      if (!contentLengthMatch) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number(contentLengthMatch[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) {
        return;
      }

      const body = this.buffer.slice(messageStart, messageEnd).toString("utf8").trim();
      this.buffer = this.buffer.slice(messageEnd);

      if (!body) {
        continue;
      }

      for (const messageBody of body.split(/\r?\n/).filter(Boolean)) {
        try {
          this.handleMessage(JSON.parse(messageBody) as TsServerMessage);
        } catch {
          // Ignore malformed tsserver output; pending requests still have their own timeouts.
        }
      }
    }
  }

  private handleMessage(message: TsServerMessage): void {
    if (message.type !== "response" || typeof message.request_seq !== "number") {
      return;
    }

    const pendingRequest = this.pending.get(message.request_seq);

    if (!pendingRequest) {
      return;
    }

    clearTimeout(pendingRequest.timer);
    this.pending.delete(message.request_seq);

    if (message.success === false) {
      pendingRequest.reject(new Error(message.message ?? `${pendingRequest.command} failed.`));
      return;
    }

    pendingRequest.resolve(message.body);
  }

  private cacheKey(command: string, args: unknown): string | undefined {
    if (!cacheableCommands.has(command)) {
      return undefined;
    }

    try {
      return `${command}:${JSON.stringify(args)}`;
    } catch {
      return undefined;
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [seq, pendingRequest] of this.pending) {
      clearTimeout(pendingRequest.timer);
      pendingRequest.reject(new Error(reason));
      this.pending.delete(seq);
    }
  }

  private rejectPendingRequest(seq: number, error: Error): void {
    const pendingRequest = this.pending.get(seq);

    if (!pendingRequest) {
      return;
    }

    clearTimeout(pendingRequest.timer);
    this.pending.delete(seq);
    pendingRequest.reject(error);
  }

  private handleProcessFailure(
    reason: string,
    child = this.process,
    killProcess = true
  ): void {
    if (child && this.process !== child) {
      return;
    }

    this.process = undefined;
    this.configured = false;
    this.openedDocuments.clear();
    this.responseCache.clear();
    this.buffer = Buffer.alloc(0);
    this.rejectAllPending(reason);

    if (killProcess && child && !child.killed) {
      try {
        child.kill();
      } catch {
        // Process cleanup is best-effort.
      }
    }
  }
}

function tsServerRequestFile(args: unknown): string | undefined {
  if (isRecord(args) && typeof args.file === "string") {
    return args.file;
  }

  if (Array.isArray(args) && typeof args[0] === "string") {
    return args[0];
  }

  return undefined;
}

function fullTextChange(oldContent: string, newContent: string): {
  line: number;
  offset: number;
  endLine: number;
  endOffset: number;
  insertString: string;
} {
  const oldLines = oldContent.split(/\r\n|\r|\n/);
  const lastOldLine = oldLines.at(-1) ?? "";

  return {
    line: 1,
    offset: 1,
    endLine: Math.max(1, oldLines.length),
    endOffset: lastOldLine.length + 1,
    insertString: newContent
  };
}

function readFileContent(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function normalizeFilePath(filePath: string): string {
  return resolve(filePath).replace(/\\/g, "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
