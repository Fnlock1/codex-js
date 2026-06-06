import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  CodeActionRequest,
  CodeActionResolveRequest,
  CodeActionResult,
  CodeCommand,
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
  CodeCompletionItem,
  CodeCompletionRequest,
  CodeCompletionResolveRequest,
  CodeCompletionResult,
  CodeCompletionTextEdit,
  CodeRenameRequest,
  CodeReferencesRequest,
  CodeSemanticTokens,
  CodeSemanticTokensLegend,
  CodeSemanticTokensRequest,
  CodeWorkspaceEdit,
  LanguageServerStatus
} from "@qoder-open/shared";
import type { WorkspaceService } from "./workspace-service.js";
import { VueTsServerBridge } from "./vue-tsserver-bridge.js";

interface LanguageServerConfig {
  languageId: string;
  lspLanguageId: string;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  initializationOptions?: Record<string, unknown>;
  workspaceSettings?: Record<string, unknown>;
}

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

interface CompletionList {
  isIncomplete?: boolean;
  items: LspCompletionItem[];
}

interface InitializeResult {
  capabilities?: {
    completionProvider?: {
      resolveProvider?: boolean;
    };
    codeActionProvider?: boolean | {
      resolveProvider?: boolean;
      codeActionKinds?: string[];
    };
    definitionProvider?: boolean | Record<string, unknown>;
    documentFormattingProvider?: boolean | Record<string, unknown>;
    documentRangeFormattingProvider?: boolean | Record<string, unknown>;
    hoverProvider?: boolean | Record<string, unknown>;
    referencesProvider?: boolean | Record<string, unknown>;
    renameProvider?: boolean | {
      prepareProvider?: boolean;
    };
    semanticTokensProvider?: {
      full?: boolean | {
        delta?: boolean;
      };
      range?: boolean | Record<string, unknown>;
      legend?: CodeSemanticTokensLegend;
    };
    executeCommandProvider?: {
      commands?: string[];
    };
  };
}

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspTextEdit {
  newText: string;
  range?: LspRange;
  insert?: LspRange;
  replace?: LspRange;
}

interface LspMarkupContent {
  kind?: "markdown" | "plaintext";
  value?: string;
}

interface LspMarkedString {
  language?: string;
  value?: string;
}

interface LspHover {
  contents?: string | LspMarkupContent | LspMarkedString | Array<string | LspMarkedString>;
  range?: LspRange;
}

interface LspLocation {
  uri: string;
  range: LspRange;
}

interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
}

interface LspDiagnostic {
  range: LspRange;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message?: string;
  tags?: number[];
}

interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{
    textDocument?: {
      uri?: string;
    };
    edits?: LspTextEdit[];
  }>;
}

interface LspCommand {
  title?: string;
  command?: string;
  arguments?: unknown[];
}

interface LspCodeAction {
  title?: string;
  kind?: string;
  diagnostics?: LspDiagnostic[];
  edit?: LspWorkspaceEdit;
  command?: LspCommand;
  isPreferred?: boolean;
  disabled?: {
    reason?: string;
  };
  data?: unknown;
}

interface PublishDiagnosticsParams {
  uri: string;
  diagnostics?: LspDiagnostic[];
}

interface LspLabelDetails {
  detail?: string;
  description?: string;
}

interface LspCompletionItem {
  label: string;
  labelDetails?: LspLabelDetails;
  kind?: number;
  detail?: string;
  documentation?: string | LspMarkupContent;
  insertText?: string;
  insertTextFormat?: 1 | 2;
  textEdit?: LspTextEdit;
  additionalTextEdits?: LspTextEdit[];
  sortText?: string;
  filterText?: string;
  commitCharacters?: string[];
  preselect?: boolean;
  tags?: number[];
  command?: LspCommand;
  data?: unknown;
}

interface OpenDocument {
  uri: string;
  version: number;
  content: string;
}

const requestTimeoutMs = 8_000;
const executeCommandTimeoutMs = 5_000;
const fileEventDebounceMs = 180;
const supportedFeatureLanguageIds = new Set(["vue", "python", "rust", "go"]);
const vueSemanticTokenLegend: CodeSemanticTokensLegend = {
  tokenTypes: [
    "namespace",
    "class",
    "enum",
    "interface",
    "typeParameter",
    "type",
    "parameter",
    "variable",
    "property",
    "enumMember",
    "function",
    "method",
    "component"
  ],
  tokenModifiers: [
    "declaration",
    "readonly",
    "static",
    "async",
    "defaultLibrary",
    "local"
  ]
};

type LanguageServerRuntimeState = NonNullable<LanguageServerStatus["state"]>;
type DiagnosticsListener = (event: CodeDiagnosticsEvent) => void;
type StatusListener = (statuses: LanguageServerStatus[]) => void;

export class LanguageServiceManager {
  private readonly appRoot: string;
  private readonly clients = new Map<string, LanguageServerClient>();
  private readonly configs: LanguageServerConfig[];
  private readonly diagnosticsListeners = new Set<DiagnosticsListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private fileWatcher: FSWatcher | undefined;
  private watchedWorkspace = "";
  private queuedFileEvents = new Map<string, CodeFileEvent>();
  private fileEventTimer: NodeJS.Timeout | undefined;

  constructor(private readonly workspaceService: WorkspaceService, mainDir: string) {
    this.appRoot = resolve(mainDir, "../..");
    this.configs = createLanguageServerConfigs(this.appRoot);
  }

  status(): LanguageServerStatus[] {
    this.ensureWorkspaceWatcher();

    return this.configs.map((config) => ({
      languageId: config.languageId,
      label: config.label,
      available: isCommandAvailable(config),
      state: this.statusState(config),
      command: [config.command, ...config.args].join(" "),
      detail: this.statusDetail(config),
      workspace: this.workspaceService.cwd,
      capabilities: this.clients.get(config.languageId)?.capabilitiesSummary()
    }));
  }

  onDiagnostics(listener: DiagnosticsListener): () => void {
    this.diagnosticsListeners.add(listener);
    return () => {
      this.diagnosticsListeners.delete(listener);
    };
  }

  onStatusChanged(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  workspaceChanged(): void {
    for (const client of this.clients.values()) {
      client.dispose();
    }

    this.clients.clear();
    this.resetWorkspaceWatcher();
    this.ensureWorkspaceWatcher();
    this.emitStatusChanged();
  }

  async completions(request: CodeCompletionRequest): Promise<CodeCompletionResult> {
    const config = this.configs.find((item) => item.languageId === request.languageId);

    if (!config) {
      return {
        source: "unavailable",
        message: `No language server configured for ${request.languageId}.`,
        items: []
      };
    }

    if (!isCommandAvailable(config)) {
      return {
        source: "unavailable",
        server: config.label,
        message: `${config.label} is not installed or not available on PATH.`,
        items: []
      };
    }

    try {
      const client = await this.clientFor(config);
      const absolutePath = this.workspaceService.resolveInsideWorkspace(request.path);
      const uri = pathToFileURL(absolutePath).toString();
      await client.syncDocument({
        uri,
        languageId: config.lspLanguageId,
        content: request.content
      });
      const result = await client.request(
        "textDocument/completion",
        {
          textDocument: { uri },
          position: request.position,
          context: request.triggerCharacter
            ? {
                triggerKind: 2,
                triggerCharacter: request.triggerCharacter
              }
            : {
                triggerKind: 1
              }
        },
        request.languageId === "vue" ? 1_800 : undefined
      );
      const normalized = completionResult(result);

      return {
        source: "lsp",
        server: config.label,
        incomplete: normalized.incomplete,
        items: normalized.items.slice(0, 250)
      };
    } catch (error) {
      return {
        source: "unavailable",
        server: config.label,
        message: error instanceof Error ? error.message : String(error),
        items: []
      };
    }
  }

  async resolveCompletion(request: CodeCompletionResolveRequest): Promise<CodeCompletionItem> {
    const config = this.configs.find((item) => item.languageId === request.languageId);

    if (!config || !isCommandAvailable(config)) {
      return request.item;
    }

    try {
      const client = await this.clientFor(config);

      if (!client.canResolveCompletion()) {
        return request.item;
      }

      if (request.path && typeof request.content === "string") {
        const absolutePath = this.workspaceService.resolveInsideWorkspace(request.path);
        await client.syncDocument({
          uri: pathToFileURL(absolutePath).toString(),
          languageId: client.lspLanguageId,
          content: request.content
        });
      }

      const lspItem = request.item.lspItem ?? request.item;
      const resolvedItem = await client.request(
        "completionItem/resolve",
        lspItem,
        request.languageId === "vue" ? 1_800 : 3_000
      );
      return completionItem(resolvedItem, request.item);
    } catch {
      return request.item;
    }
  }

  async syncDocument(request: CodeDocumentRequest): Promise<void> {
    const client = await this.clientForRequest(request.languageId);

    if (!client) {
      return;
    }

    const absolutePath = this.workspaceService.resolveInsideWorkspace(request.path);
    await client.syncDocument({
      uri: pathToFileURL(absolutePath).toString(),
      languageId: client.lspLanguageId,
      content: request.content
    });
  }

  async didSaveDocument(request: CodeDocumentSaveRequest): Promise<void> {
    const client = await this.clientForRequest(request.languageId);

    if (!client) {
      return;
    }

    const absolutePath = this.workspaceService.resolveInsideWorkspace(request.path);

    if (typeof request.content === "string") {
      await client.syncDocument({
        uri: pathToFileURL(absolutePath).toString(),
        languageId: client.lspLanguageId,
        content: request.content
      });
    }

    client.didSaveDocument(pathToFileURL(absolutePath).toString(), request.content);
  }

  async didChangeFiles(events: CodeFileEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    this.ensureWorkspaceWatcher();

    for (const client of this.clients.values()) {
      client.didChangeFiles(events);
    }
  }

  async hover(request: CodeHoverRequest): Promise<CodeHoverResult | null> {
    const client = await this.clientForRequest(request.languageId);

    if (!client) {
      return null;
    }

    const absolutePath = this.workspaceService.resolveInsideWorkspace(request.path);
    const uri = pathToFileURL(absolutePath).toString();
    await client.syncDocument({
      uri,
      languageId: client.lspLanguageId,
      content: request.content
    });

    const result = await client.request("textDocument/hover", {
      textDocument: { uri },
      position: request.position
    });

    return hoverResult(result);
  }

  async definition(request: CodeDefinitionRequest): Promise<CodeLocation[]> {
    const client = await this.clientForRequest(request.languageId);

    if (!client) {
      return [];
    }

    const absolutePath = this.workspaceService.resolveInsideWorkspace(request.path);
    const uri = pathToFileURL(absolutePath).toString();
    await client.syncDocument({
      uri,
      languageId: client.lspLanguageId,
      content: request.content
    });

    const result = await client.request("textDocument/definition", {
      textDocument: { uri },
      position: request.position
    });

    return locationResults(result, this.workspaceService.cwd);
  }

  async references(request: CodeReferencesRequest): Promise<CodeLocation[]> {
    const client = await this.clientForRequest(request.languageId);

    if (!client) {
      return [];
    }

    const absolutePath = this.workspaceService.resolveInsideWorkspace(request.path);
    const uri = pathToFileURL(absolutePath).toString();
    await client.syncDocument({
      uri,
      languageId: client.lspLanguageId,
      content: request.content
    });

    const result = await client.request("textDocument/references", {
      textDocument: { uri },
      position: request.position,
      context: {
        includeDeclaration: request.includeDeclaration ?? true
      }
    });

    return locationResults(result, this.workspaceService.cwd);
  }

  async codeActions(request: CodeActionRequest): Promise<CodeActionResult[]> {
    try {
      const client = await this.clientForRequest(request.languageId);

      if (!client) {
        return [];
      }

      const absolutePath = this.workspaceService.resolveInsideWorkspace(request.path);
      const uri = pathToFileURL(absolutePath).toString();
      await client.syncDocument({
        uri,
        languageId: client.lspLanguageId,
        content: request.content
      });

      const result = await client.request("textDocument/codeAction", {
        textDocument: { uri },
        range: request.range,
        context: {
          diagnostics: request.diagnostics ?? [],
          only: request.only ? [request.only] : undefined
        }
      });

      return codeActionResults(result, this.workspaceService.cwd);
    } catch {
      return [];
    }
  }

  async resolveCodeAction(request: CodeActionResolveRequest): Promise<CodeActionResult> {
    const config = this.configs.find((item) => item.languageId === request.languageId);

    if (!config || !isCommandAvailable(config)) {
      return request.action;
    }

    try {
      const client = await this.clientFor(config);

      if (!client.canResolveCodeAction()) {
        return request.action;
      }

      const result = await client.request(
        "codeAction/resolve",
        request.action.lspAction ?? request.action
      );
      return codeActionResult(result, request.action, this.workspaceService.cwd) ?? request.action;
    } catch {
      return request.action;
    }
  }

  async executeCommand(request: CodeExecuteCommandRequest): Promise<CodeExecuteCommandResult> {
    const client = await this.clientForRequest(request.languageId);

    if (!client) {
      return {
        workspaceEdits: []
      };
    }

    try {
      return await client.executeCommand(request.command);
    } catch {
      return {
        workspaceEdits: []
      };
    }
  }

  async rename(request: CodeRenameRequest): Promise<CodeWorkspaceEdit | null> {
    const client = await this.clientForRequest(request.languageId);

    if (!client) {
      return null;
    }

    const absolutePath = this.workspaceService.resolveInsideWorkspace(request.path);
    const uri = pathToFileURL(absolutePath).toString();
    await client.syncDocument({
      uri,
      languageId: client.lspLanguageId,
      content: request.content
    });

    const result = await client.request("textDocument/rename", {
      textDocument: { uri },
      position: request.position,
      newName: request.newName
    });

    return workspaceEdit(result, this.workspaceService.cwd);
  }

  async format(request: CodeFormatRequest): Promise<CodeCompletionTextEdit[]> {
    const client = await this.clientForRequest(request.languageId);

    if (client) {
      try {
        const absolutePath = this.workspaceService.resolveInsideWorkspace(request.path);
        const uri = pathToFileURL(absolutePath).toString();
        await client.syncDocument({
          uri,
          languageId: client.lspLanguageId,
          content: request.content
        });

        const method = request.range ? "textDocument/rangeFormatting" : "textDocument/formatting";
        const params = request.range
          ? {
              textDocument: { uri },
              range: request.range,
              options: request.options
            }
          : {
              textDocument: { uri },
              options: request.options
            };
        const result = await client.request(method, params);
        const edits = Array.isArray(result)
          ? result
              .map((edit) => completionTextEdit(edit))
              .filter((edit): edit is CodeCompletionTextEdit => Boolean(edit))
          : [];

        if (edits.length > 0) {
          return edits;
        }
      } catch {
        // External formatters below provide a pragmatic fallback when LSP formatting fails.
      }
    }

    return this.externalFormat(request);
  }

  async semanticTokens(request: CodeSemanticTokensRequest): Promise<CodeSemanticTokens | null> {
    try {
      const client = await this.clientForRequest(request.languageId);

      if (!client || !client.canProvideSemanticTokens()) {
        return null;
      }

      const absolutePath = this.workspaceService.resolveInsideWorkspace(request.path);
      const uri = pathToFileURL(absolutePath).toString();
      await client.syncDocument({
        uri,
        languageId: client.lspLanguageId,
        content: request.content
      });

      const result = request.range
        ? await client.request(
            "textDocument/semanticTokens/range",
            {
              textDocument: { uri },
              range: request.range
            },
            request.languageId === "vue" ? 2_500 : 5_000
          )
        : await client.request(
            "textDocument/semanticTokens/full",
            {
              textDocument: { uri },
              previousResultId: request.previousResultId ?? undefined
            },
            request.languageId === "vue" ? 2_500 : 6_000
          );

      return semanticTokensResult(result);
    } catch {
      return null;
    }
  }

  private async externalFormat(request: CodeFormatRequest): Promise<CodeCompletionTextEdit[]> {
    if (request.range) {
      return [];
    }

    const absolutePath = this.workspaceService.resolveInsideWorkspace(request.path);
    const formatter = formatterForRequest(request, absolutePath, this.workspaceService.cwd, this.appRoot);

    if (!formatter) {
      return [];
    }

    try {
      const formatted = await runFormatter(formatter.command, formatter.args, request.content, formatter.cwd);

      if (formatted === request.content) {
        return [];
      }

      return [
        {
          newText: formatted,
          range: fullDocumentRange(request.content)
        }
      ];
    } catch {
      return [];
    }
  }

  dispose(): void {
    this.fileWatcher?.close();
    this.fileWatcher = undefined;

    if (this.fileEventTimer) {
      clearTimeout(this.fileEventTimer);
      this.fileEventTimer = undefined;
    }

    for (const client of this.clients.values()) {
      client.dispose();
    }

    this.clients.clear();
  }

  private async clientForRequest(languageId: string): Promise<LanguageServerClient | undefined> {
    if (!supportedFeatureLanguageIds.has(languageId)) {
      return undefined;
    }

    const config = this.configs.find((item) => item.languageId === languageId);

    if (!config || !isCommandAvailable(config)) {
      return undefined;
    }

    return this.clientFor(config);
  }

  private async clientFor(config: LanguageServerConfig): Promise<LanguageServerClient> {
    this.ensureWorkspaceWatcher();
    const workspacePath = this.workspaceService.cwd;
    const existingClient = this.clients.get(config.languageId);

    if (existingClient) {
      if (existingClient.workspacePath !== workspacePath) {
        existingClient.dispose();
        this.clients.delete(config.languageId);
      } else {
        await existingClient.initialize();
        return existingClient;
      }
    }

    const client = new LanguageServerClient(
      config,
      workspacePath,
      (event) => this.emitDiagnostics(event),
      () => this.emitStatusChanged(),
      this.createVueTsServerBridge(workspacePath)
    );
    this.clients.set(config.languageId, client);
    await client.initialize();
    return client;
  }

  private statusState(config: LanguageServerConfig): LanguageServerRuntimeState {
    if (!isCommandAvailable(config)) {
      return "missing";
    }

    return this.clients.get(config.languageId)?.runtimeState ?? "stopped";
  }

  private statusDetail(config: LanguageServerConfig): string | undefined {
    if (!isCommandAvailable(config)) {
      return "Language server executable was not found.";
    }

    return this.clients.get(config.languageId)?.detail ?? "Installed, starts when a matching file opens.";
  }

  private createVueTsServerBridge(workspacePath: string): VueTsServerBridge {
    return new VueTsServerBridge({
      nodeExecutable: nodeCommand(),
      tsserverPath: join(this.appRoot, "node_modules", "typescript", "lib", "tsserver.js"),
      pluginProbeLocation: join(this.appRoot, "node_modules"),
      workspacePath
    });
  }

  private emitDiagnostics(event: CodeDiagnosticsEvent): void {
    for (const listener of this.diagnosticsListeners) {
      listener(event);
    }
  }

  private emitStatusChanged(): void {
    const statuses = this.status();

    for (const listener of this.statusListeners) {
      listener(statuses);
    }
  }

  private ensureWorkspaceWatcher(): void {
    const workspacePath = this.workspaceService.cwd;

    if (this.fileWatcher && this.watchedWorkspace === workspacePath) {
      return;
    }

    this.resetWorkspaceWatcher();
    this.watchedWorkspace = workspacePath;

    try {
      this.fileWatcher = watch(
        workspacePath,
        {
          recursive: true
        },
        (eventType, filename) => {
          if (!filename) {
            return;
          }

          const relativePath = normalizeWorkspacePath(String(filename));

          if (!relativePath || shouldIgnoreWorkspaceEvent(relativePath)) {
            return;
          }

          const absolutePath = resolve(workspacePath, relativePath);
          const type: CodeFileEvent["type"] =
            eventType === "rename" ? (existsSync(absolutePath) ? "created" : "deleted") : "changed";
          this.queueFileEvent({
            path: relativePath,
            type
          });
        }
      );
    } catch {
      this.fileWatcher = undefined;
    }
  }

  private resetWorkspaceWatcher(): void {
    this.fileWatcher?.close();
    this.fileWatcher = undefined;
    this.watchedWorkspace = "";
    this.queuedFileEvents.clear();

    if (this.fileEventTimer) {
      clearTimeout(this.fileEventTimer);
      this.fileEventTimer = undefined;
    }
  }

  private queueFileEvent(event: CodeFileEvent): void {
    this.queuedFileEvents.set(event.path, event);

    if (this.fileEventTimer) {
      clearTimeout(this.fileEventTimer);
    }

    this.fileEventTimer = setTimeout(() => {
      const events = Array.from(this.queuedFileEvents.values());
      this.queuedFileEvents.clear();
      this.fileEventTimer = undefined;
      void this.didChangeFiles(events);
    }, fileEventDebounceMs);
  }
}

class LanguageServerClient {
  private readonly pending = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly openDocuments = new Map<string, OpenDocument>();
  private process: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private initialized = false;
  private serverCapabilities: InitializeResult["capabilities"] | undefined;
  private state: LanguageServerRuntimeState = "stopped";
  private statusMessage = "Installed, starts when a matching file opens.";
  private disposing = false;
  private commandWorkspaceEdits: CodeWorkspaceEdit[] | undefined;

  constructor(
    private readonly config: LanguageServerConfig,
    readonly workspacePath: string,
    private readonly onDiagnostics: DiagnosticsListener,
    private readonly onStatusChange: () => void,
    private readonly vueTsServerBridge: VueTsServerBridge
  ) {}

  get runtimeState(): LanguageServerRuntimeState {
    return this.state;
  }

  get detail(): string {
    return this.statusMessage;
  }

  get lspLanguageId(): string {
    return this.config.lspLanguageId;
  }

  capabilitiesSummary(): NonNullable<LanguageServerStatus["capabilities"]> {
    return {
      diagnostics: this.initialized,
      completion: Boolean(this.serverCapabilities?.completionProvider),
      hover: Boolean(this.serverCapabilities?.hoverProvider),
      definition: Boolean(this.serverCapabilities?.definitionProvider),
      references: Boolean(this.serverCapabilities?.referencesProvider),
      codeAction: Boolean(this.serverCapabilities?.codeActionProvider),
      rename: Boolean(this.serverCapabilities?.renameProvider),
      semanticTokens: Boolean(this.serverCapabilities?.semanticTokensProvider),
      formatting: Boolean(
        this.serverCapabilities?.documentFormattingProvider ||
        this.serverCapabilities?.documentRangeFormattingProvider
      )
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.disposing = false;
    this.setState("starting", "Starting language server and loading project context...");
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.workspacePath,
      env: process.env,
      windowsHide: true
    });
    this.process = child;
    child.stdout.on("data", (chunk) => this.handleData(chunk));
    child.stdout.on("error", (error) => this.handleProcessFailure(`${this.config.label} stdout failed: ${error.message}.`, child));
    child.stdin.on("error", (error) => this.handleProcessFailure(`${this.config.label} input pipe closed: ${error.message}.`, child));
    child.stderr.on("data", () => undefined);
    child.stderr.on("error", () => undefined);
    child.on("exit", () => {
      this.handleProcessExit(child);
    });
    child.on("error", (error) => {
      this.handleProcessFailure(error.message, child, false);
    });

    let initializeResult: InitializeResult;

    try {
      initializeResult = (await this.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.workspacePath).toString(),
        rootPath: this.workspacePath,
        workspaceFolders: [
          {
            uri: pathToFileURL(this.workspacePath).toString(),
            name: "workspace"
          }
        ],
        capabilities: {
          textDocument: {
            completion: {
              dynamicRegistration: false,
              completionItem: {
                snippetSupport: true,
                additionalTextEditsSupport: true,
                documentationFormat: ["markdown", "plaintext"],
                commitCharactersSupport: true,
                deprecatedSupport: true,
                preselectSupport: true,
                tagSupport: {
                  valueSet: [1]
                },
                insertReplaceSupport: true,
                insertTextModeSupport: {
                  valueSet: [1, 2]
                },
                labelDetailsSupport: true,
                resolveSupport: {
                  properties: [
                    "documentation",
                    "detail",
                    "additionalTextEdits",
                    "sortText",
                    "filterText",
                    "insertText",
                    "textEdit",
                    "command"
                  ]
                }
              }
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ["markdown", "plaintext"]
            },
            definition: {
              dynamicRegistration: false,
              linkSupport: true
            },
            references: {
              dynamicRegistration: false
            },
            publishDiagnostics: {
              relatedInformation: true,
              versionSupport: false,
              tagSupport: {
                valueSet: [1, 2]
              },
              codeDescriptionSupport: true,
              dataSupport: true
            },
            codeAction: {
              dynamicRegistration: false,
              isPreferredSupport: true,
              dataSupport: true,
              disabledSupport: true,
              resolveSupport: {
                properties: ["edit", "command"]
              },
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: [
                    "",
                    "quickfix",
                    "refactor",
                    "refactor.extract",
                    "refactor.inline",
                    "refactor.rewrite",
                    "source",
                    "source.addMissingImports",
                    "source.addMissingImports.ts",
                    "source.fixAll",
                    "source.organizeImports"
                  ]
                }
              }
            },
            rename: {
              dynamicRegistration: false,
              prepareSupport: true
            },
            formatting: {
              dynamicRegistration: false
            },
            rangeFormatting: {
              dynamicRegistration: false
            },
            semanticTokens: {
              dynamicRegistration: false,
              requests: {
                full: true,
                range: true
              },
              tokenTypes: vueSemanticTokenLegend.tokenTypes,
              tokenModifiers: vueSemanticTokenLegend.tokenModifiers,
              formats: ["relative"],
              overlappingTokenSupport: false,
              multilineTokenSupport: true,
              augmentsSyntaxTokens: true,
            },
            synchronization: {
              didSave: true,
              dynamicRegistration: false
            }
          },
          workspace: {
            configuration: true,
            didChangeWatchedFiles: {
              dynamicRegistration: false
            },
            executeCommand: {
              dynamicRegistration: false
            },
            applyEdit: true,
            workspaceFolders: true
          }
        },
        initializationOptions: this.initializationOptions()
      })) as InitializeResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.handleProcessFailure(message, child);
      throw error;
    }
    this.serverCapabilities = initializeResult.capabilities;
    this.notify("initialized", {});
    this.notify("workspace/didChangeConfiguration", {
      settings: this.workspaceSettings()
    });
    this.initialized = true;
    this.setState("ready", this.readyDetail());
  }

  canResolveCompletion(): boolean {
    return Boolean(this.serverCapabilities?.completionProvider?.resolveProvider);
  }

  canResolveCodeAction(): boolean {
    const provider = this.serverCapabilities?.codeActionProvider;
    return typeof provider === "object" && Boolean(provider.resolveProvider);
  }

  canProvideSemanticTokens(): boolean {
    return Boolean(this.serverCapabilities?.semanticTokensProvider);
  }

  async executeCommand(command: CodeCommand): Promise<CodeExecuteCommandResult> {
    if (!command.command) {
      return {
        workspaceEdits: []
      };
    }

    const previousCollector = this.commandWorkspaceEdits;
    const workspaceEdits: CodeWorkspaceEdit[] = [];
    this.commandWorkspaceEdits = workspaceEdits;

    try {
      const result = await this.request(
        "workspace/executeCommand",
        {
          command: command.command,
          arguments: command.arguments ?? []
        },
        executeCommandTimeoutMs
      );

      return {
        workspaceEdits,
        result
      };
    } finally {
      this.commandWorkspaceEdits = previousCollector;
    }
  }

  async syncDocument(input: {
    uri: string;
    languageId: string;
    content: string;
  }): Promise<void> {
    const existingDocument = this.openDocuments.get(input.uri);

    if (!existingDocument) {
      const document: OpenDocument = {
        uri: input.uri,
        version: 1,
        content: input.content
      };
      this.openDocuments.set(input.uri, document);
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri: input.uri,
          languageId: input.languageId,
          version: document.version,
          text: input.content
        }
      });
      return;
    }

    if (existingDocument.content === input.content) {
      return;
    }

    existingDocument.version += 1;
    existingDocument.content = input.content;
    this.notify("textDocument/didChange", {
      textDocument: {
        uri: input.uri,
        version: existingDocument.version
      },
      contentChanges: [
        {
          text: input.content
        }
      ]
    });
  }

  didSaveDocument(uri: string, content?: string): void {
    if (!this.initialized) {
      return;
    }

    this.notify("textDocument/didSave", {
      textDocument: {
        uri
      },
      text: content
    });
  }

  didChangeFiles(events: CodeFileEvent[]): void {
    if (!this.initialized || events.length === 0) {
      return;
    }

    this.notify("workspace/didChangeWatchedFiles", {
      changes: events.map((event) => ({
        uri: pathToFileURL(resolve(this.workspacePath, event.path)).toString(),
        type: fileEventType(event.type)
      }))
    });
  }

  request(method: string, params: unknown, timeoutMs = requestTimeoutMs): Promise<unknown> {
    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.config.label} timed out on ${method}.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer
      });

      try {
        this.write({
          jsonrpc: "2.0",
          id,
          method,
          params
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(toError(error));
      }
    });
  }

  dispose(): void {
    try {
      this.disposing = true;
      this.notify("shutdown", null);
      this.notify("exit", null);
      this.process?.kill();
    } catch {
      // Dispose is best-effort.
    }

    this.rejectAllPending(`${this.config.label} disposed.`);
    this.vueTsServerBridge.dispose();
    this.openDocuments.clear();
    this.serverCapabilities = undefined;
    this.process = undefined;
    this.initialized = false;
    this.setState("stopped", "Language server stopped.");
  }

  private notify(method: string, params: unknown): void {
    try {
      this.write({
        jsonrpc: "2.0",
        method,
        params
      });
    } catch {
      // Notifications are best-effort. Request callers still receive structured failures.
    }
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

      const body = this.buffer.slice(messageStart, messageEnd).toString("utf8");
      this.buffer = this.buffer.slice(messageEnd);

      try {
        this.handleMessage(JSON.parse(body) as RpcMessage);
      } catch (error) {
        this.handleProcessFailure(
          `${this.config.label} sent an invalid language-server message: ${toError(error).message}.`
        );
        return;
      }
    }
  }

  private handleMessage(message: RpcMessage): void {
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pendingRequest = this.pending.get(message.id);

      if (!pendingRequest) {
        return;
      }

      clearTimeout(pendingRequest.timer);
      this.pending.delete(message.id);

      if (message.error) {
        pendingRequest.reject(new Error(message.error.message));
        return;
      }

      pendingRequest.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      const result = this.serverRequestResult(message.method, message.params);
      try {
        this.write({
          jsonrpc: "2.0",
          id: message.id,
          result
        });
      } catch {
        // The server may have exited while a request response was being prepared.
      }
      return;
    }

    if (message.method) {
      this.handleNotification(message.method, message.params);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "tsserver/request") {
      this.handleVueTsServerRequest(params);
      return;
    }

    if (method === "textDocument/publishDiagnostics") {
      this.publishDiagnostics(params);
      return;
    }

    if (method === "window/logMessage" && isRecord(params) && typeof params.message === "string") {
      this.statusMessage = params.message.slice(0, 180);
      this.onStatusChange();
    }
  }

  private handleVueTsServerRequest(params: unknown): void {
    const payload = Array.isArray(params) && params.length === 1 && Array.isArray(params[0])
      ? params[0]
      : params;

    if (this.config.languageId !== "vue" || !Array.isArray(payload)) {
      return;
    }

    const [requestId, command, args] = payload;

    if ((typeof requestId !== "number" && typeof requestId !== "string") || typeof command !== "string") {
      return;
    }

    void this.forwardVueTsServerRequest(requestId, command, args);
  }

  private async forwardVueTsServerRequest(
    requestId: number | string,
    command: string,
    args: unknown
  ): Promise<void> {
    let response: unknown;

    try {
      response = await this.vueTsServerBridge.forward(
        command,
        args,
        (filePath) => this.openDocuments.get(pathToFileURL(filePath).toString())?.content
      );
    } catch {
      response = vueTsServerFallbackResponse(command);
    }

    try {
      this.write({
        jsonrpc: "2.0",
        method: "tsserver/response",
        params: [[requestId, response]]
      });
    } catch {
      // The Volar bridge is best-effort; a shutting-down server should not crash the IPC handler.
    }
  }

  private publishDiagnostics(params: unknown): void {
    if (!isRecord(params) || typeof params.uri !== "string") {
      return;
    }

    const diagnostics = Array.isArray(params.diagnostics)
      ? params.diagnostics
          .map((diagnostic) => codeDiagnostic(diagnostic))
          .filter((diagnostic): diagnostic is CodeDiagnostic => Boolean(diagnostic))
      : [];

    this.onDiagnostics({
      languageId: this.config.languageId,
      uri: params.uri,
      path: uriToWorkspaceRelativePath(params.uri, this.workspacePath),
      diagnostics
    });
  }

  private serverRequestResult(method: string, params: unknown): unknown {
    if (method === "workspace/configuration") {
      return this.configurationResponse(params);
    }

    if (method === "workspace/workspaceFolders") {
      return this.workspaceFolders();
    }

    if (method === "workspace/applyEdit") {
      const edit = this.workspaceEditFromApplyEditParams(params);

      if (edit && this.commandWorkspaceEdits) {
        this.commandWorkspaceEdits.push(edit);
        return {
          applied: true
        };
      }

      return {
        applied: false,
        failureReason: "Workspace edits are applied through Monaco workspace edit handlers."
      };
    }

    if (
      method === "client/registerCapability" ||
      method === "client/unregisterCapability" ||
      method === "workDoneProgress/create" ||
      method === "window/showMessageRequest" ||
      method === "window/showDocument" ||
      method === "workspace/inlayHint/refresh" ||
      method === "workspace/semanticTokens/refresh" ||
      method === "workspace/diagnostic/refresh" ||
      method === "workspace/codeLens/refresh"
    ) {
      return null;
    }

    return null;
  }

  private configurationResponse(params: unknown): unknown[] {
    const items = isRecord(params) && Array.isArray(params.items) ? params.items : [];

    return items.map((item) => {
      const section = isRecord(item) && typeof item.section === "string" ? item.section : undefined;
      return this.configurationFor(section);
    });
  }

  private configurationFor(section: string | undefined): unknown {
    const settings = this.workspaceSettings();

    if (!section) {
      return settings;
    }

    return getDottedSetting(settings, section) ?? {};
  }

  private workspaceSettings(): Record<string, unknown> {
    if (this.config.languageId !== "vue") {
      return this.config.workspaceSettings ?? {};
    }

    return {
      ...(this.config.workspaceSettings ?? {}),
      qoder: {
        vueProject: vueProjectContext(this.workspacePath)
      }
    };
  }

  private workspaceFolders(): { uri: string; name: string }[] {
    return [
      {
        uri: pathToFileURL(this.workspacePath).toString(),
        name: "workspace"
      }
    ];
  }

  private workspaceEditFromApplyEditParams(params: unknown): CodeWorkspaceEdit | null {
    if (!isRecord(params)) {
      return null;
    }

    return workspaceEdit(params.edit, this.workspacePath);
  }

  private write(message: RpcMessage): void {
    const child = this.process;

    if (!child) {
      throw new Error(`${this.config.label} is not running.`);
    }

    if (child.stdin.destroyed || child.stdin.writableEnded || !child.stdin.writable) {
      const error = new Error(`${this.config.label} input pipe is closed.`);
      this.handleProcessFailure(error.message, child);
      throw error;
    }

    const body = JSON.stringify(message);
    const payload = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;

    try {
      child.stdin.write(payload, "utf8", (error) => {
        if (error) {
          this.handleProcessFailure(`${this.config.label} input pipe failed: ${error.message}.`, child);
        }
      });
    } catch (error) {
      const writeError = toError(error);
      this.handleProcessFailure(`${this.config.label} input pipe failed: ${writeError.message}.`, child);
      throw writeError;
    }
  }

  private handleProcessExit(child: ChildProcessWithoutNullStreams): void {
    if (this.process !== child) {
      return;
    }

    this.rejectAllPending(`${this.config.label} exited.`);
    this.openDocuments.clear();
    this.buffer = Buffer.alloc(0);
    this.process = undefined;
    this.serverCapabilities = undefined;
    this.initialized = false;
    this.vueTsServerBridge.dispose();
    this.setState(this.disposing ? "stopped" : "crashed", this.disposing
      ? "Language server stopped."
      : `${this.config.label} exited.`);
  }

  private handleProcessFailure(
    detail: string,
    child = this.process,
    killProcess = true
  ): void {
    if (child && this.process !== child) {
      return;
    }

    this.rejectAllPending(detail);
    this.openDocuments.clear();
    this.buffer = Buffer.alloc(0);
    this.serverCapabilities = undefined;
    this.initialized = false;
    this.process = undefined;
    this.vueTsServerBridge.dispose();

    if (killProcess && child && !child.killed) {
      try {
        child.kill();
      } catch {
        // Process cleanup is best-effort.
      }
    }

    this.setState(this.disposing ? "stopped" : "crashed", this.disposing
      ? "Language server stopped."
      : detail);
  }

  private setState(state: LanguageServerRuntimeState, detail: string): void {
    this.state = state;
    this.statusMessage = detail;
    this.onStatusChange();
  }

  private initializationOptions(): Record<string, unknown> {
    if (this.config.languageId !== "vue") {
      return this.config.initializationOptions ?? {};
    }

    return {
      ...(this.config.initializationOptions ?? {}),
      qoder: {
        vueProject: vueProjectContext(this.workspacePath)
      }
    };
  }

  private readyDetail(): string {
    if (this.config.languageId !== "vue") {
      return "Ready. Project indexing may continue in the background.";
    }

    const context = vueProjectContext(this.workspacePath);
    const projectFiles = context.projectFiles.length > 0
      ? context.projectFiles.join(", ")
      : "no tsconfig/jsconfig/package.json";

    return `Ready. Vue SFC ${context.sfcFilesPresent ? "detected" : "not detected"}; TypeScript project context: ${projectFiles}.`;
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pendingRequest] of this.pending) {
      clearTimeout(pendingRequest.timer);
      pendingRequest.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}

interface ExternalFormatter {
  command: string;
  args: string[];
  cwd: string;
}

function formatterForRequest(
  request: CodeFormatRequest,
  absolutePath: string,
  workspacePath: string,
  appRoot: string
): ExternalFormatter | undefined {
  if (request.languageId === "vue") {
    const prettier = findFormatterCommand("prettier", workspacePath, appRoot);

    return prettier
      ? {
          command: prettier,
          args: ["--stdin-filepath", absolutePath],
          cwd: workspacePath
        }
      : undefined;
  }

  if (request.languageId === "python") {
    const ruff = findFormatterCommand("ruff", workspacePath, appRoot);

    if (ruff) {
      return {
        command: ruff,
        args: ["format", "--stdin-filename", absolutePath, "-"],
        cwd: workspacePath
      };
    }

    const black = findFormatterCommand("black", workspacePath, appRoot);

    return black
      ? {
          command: black,
          args: ["--quiet", "--stdin-filename", absolutePath, "-"],
          cwd: workspacePath
        }
      : undefined;
  }

  if (request.languageId === "go") {
    const gofmt = findFormatterCommand("gofmt", workspacePath, appRoot);

    return gofmt
      ? {
          command: gofmt,
          args: [],
          cwd: workspacePath
        }
      : undefined;
  }

  if (request.languageId === "rust") {
    const rustfmt = findFormatterCommand("rustfmt", workspacePath, appRoot);

    return rustfmt
      ? {
          command: rustfmt,
          args: ["--emit", "stdout"],
          cwd: workspacePath
        }
      : undefined;
  }

  return undefined;
}

function findFormatterCommand(command: string, workspacePath: string, appRoot: string): string | undefined {
  for (const binDir of [
    join(workspacePath, "node_modules", ".bin"),
    join(appRoot, "node_modules", ".bin")
  ]) {
    for (const executable of formatterExecutableNames(command)) {
      const candidate = join(binDir, executable);

      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return commandExists(command) ? command : undefined;
}

function formatterExecutableNames(command: string): string[] {
  if (process.platform !== "win32") {
    return [command];
  }

  return [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command];
}

async function runFormatter(
  command: string,
  args: string[],
  input: string,
  cwd: string
): Promise<string> {
  return new Promise((resolveFormatter, rejectFormatter) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectFormatter(new Error("Formatter timed out."));
    }, 20_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectFormatter(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);

      if (code === 0) {
        resolveFormatter(stdout);
        return;
      }

      rejectFormatter(new Error(stderr.trim() || `Formatter exited with code ${code ?? "unknown"}.`));
    });
    child.stdin.end(input, "utf8");
  });
}

function fullDocumentRange(content: string): CodeCompletionTextEdit["range"] {
  const lines = content.split(/\r\n|\r|\n/);
  const lastLine = lines.at(-1) ?? "";

  return {
    start: {
      line: 0,
      character: 0
    },
    end: {
      line: Math.max(0, lines.length - 1),
      character: lastLine.length
    }
  };
}

function hoverResult(result: unknown): CodeHoverResult | null {
  if (!isRecord(result)) {
    return null;
  }

  const hover = result as LspHover;
  const contents = hoverContents(hover.contents);

  if (contents.length === 0) {
    return null;
  }

  return {
    contents,
    range: isLspRange(hover.range) ? hover.range : undefined
  };
}

function hoverContents(contents: LspHover["contents"]): CodeHoverResult["contents"] {
  if (!contents) {
    return [];
  }

  if (typeof contents === "string") {
    return [
      {
        value: contents,
        kind: "plaintext"
      }
    ];
  }

  if (Array.isArray(contents)) {
    return contents.flatMap((item) => hoverContents(item));
  }

  if (isMarkupContent(contents)) {
    const content: CodeHoverResult["contents"][number] = {
      value: contents.value ?? "",
      kind: contents.kind === "plaintext" ? "plaintext" : "markdown"
    };

    return [content].filter((item) => item.value.trim());
  }

  if (isRecord(contents) && typeof contents.value === "string") {
    const content: CodeHoverResult["contents"][number] = {
      value: typeof contents.language === "string"
        ? `\`\`\`${contents.language}\n${contents.value}\n\`\`\``
        : contents.value,
      kind: typeof contents.language === "string" ? "markdown" : "plaintext"
    };

    return [
      content
    ];
  }

  return [];
}

function locationResults(result: unknown, workspacePath: string): CodeLocation[] {
  const values = Array.isArray(result) ? result : result ? [result] : [];

  return values
    .map((value) => codeLocation(value, workspacePath))
    .filter((location): location is CodeLocation => Boolean(location));
}

function codeLocation(value: unknown, workspacePath: string): CodeLocation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value.targetUri === "string" && isLspRange(value.targetRange)) {
    return {
      uri: value.targetUri,
      path: uriToWorkspaceRelativePath(value.targetUri, workspacePath),
      range: value.targetRange,
      targetSelectionRange: isLspRange(value.targetSelectionRange)
        ? value.targetSelectionRange
        : undefined
    };
  }

  if (typeof value.uri === "string" && isLspRange(value.range)) {
    return {
      uri: value.uri,
      path: uriToWorkspaceRelativePath(value.uri, workspacePath),
      range: value.range
    };
  }

  return undefined;
}

function codeDiagnostic(value: unknown): CodeDiagnostic | undefined {
  if (!isRecord(value) || !isLspRange(value.range) || typeof value.message !== "string") {
    return undefined;
  }

  return {
    range: value.range,
    severity: isDiagnosticSeverity(value.severity) ? value.severity : undefined,
    code: typeof value.code === "string" || typeof value.code === "number" ? value.code : undefined,
    source: typeof value.source === "string" ? value.source : undefined,
    message: value.message,
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is number => typeof tag === "number") : undefined
  };
}

function codeActionResults(result: unknown, workspacePath: string): CodeActionResult[] {
  return Array.isArray(result)
    ? result
        .map((action) => codeActionResult(action, undefined, workspacePath))
        .filter((action): action is CodeActionResult => Boolean(action))
    : [];
}

function codeActionResult(
  value: unknown,
  fallback: CodeActionResult | undefined,
  workspacePath: string
): CodeActionResult | undefined {
  if (!isRecord(value)) {
    return fallback;
  }

  const action = value as LspCodeAction;
  const title = typeof action.title === "string" ? action.title : fallback?.title;
  const directCommand = codeCommand(value);

  if (!title) {
    return fallback;
  }

  return {
    title,
    kind: typeof action.kind === "string" ? action.kind : fallback?.kind,
    isPreferred: typeof action.isPreferred === "boolean" ? action.isPreferred : fallback?.isPreferred,
    diagnostics: Array.isArray(action.diagnostics)
      ? action.diagnostics
          .map((diagnostic) => codeDiagnostic(diagnostic))
          .filter((diagnostic): diagnostic is CodeDiagnostic => Boolean(diagnostic))
      : fallback?.diagnostics,
    edit: workspaceEdit(action.edit, workspacePath) ?? fallback?.edit,
    command: codeCommand(action.command) ?? directCommand ?? fallback?.command,
    lspAction: value
  };
}

function codeCommand(value: unknown): CodeCommand | undefined {
  if (!isRecord(value) || typeof value.command !== "string") {
    return undefined;
  }

  return {
    title: typeof value.title === "string" ? value.title : undefined,
    command: value.command,
    arguments: Array.isArray(value.arguments) ? value.arguments : undefined
  };
}

function workspaceEdit(value: unknown, workspacePath: string): CodeWorkspaceEdit | null {
  if (!isRecord(value)) {
    return null;
  }

  const edit = value as LspWorkspaceEdit;
  const changes: Record<string, CodeCompletionTextEdit[]> = {};
  const documentChanges: NonNullable<CodeWorkspaceEdit["documentChanges"]> = [];

  if (edit.changes && isRecord(edit.changes)) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      if (!Array.isArray(edits)) {
        continue;
      }

      const path = uriToWorkspaceRelativePath(uri, workspacePath);
      const mappedEdits = edits
        .map((textEdit) => completionTextEdit(textEdit))
        .filter((textEdit): textEdit is CodeCompletionTextEdit => Boolean(textEdit));

      if (path && mappedEdits.length > 0) {
        changes[path] = mappedEdits;
      }
    }
  }

  if (Array.isArray(edit.documentChanges)) {
    for (const documentChange of edit.documentChanges) {
      const uri = documentChange.textDocument?.uri;

      if (!uri || !Array.isArray(documentChange.edits)) {
        continue;
      }

      const edits = documentChange.edits
        .map((textEdit) => completionTextEdit(textEdit))
        .filter((textEdit): textEdit is CodeCompletionTextEdit => Boolean(textEdit));

      if (edits.length === 0) {
        continue;
      }

      documentChanges.push({
        uri,
        path: uriToWorkspaceRelativePath(uri, workspacePath),
        edits
      });
    }
  }

  const normalized: CodeWorkspaceEdit = {};

  if (Object.keys(changes).length > 0) {
    normalized.changes = changes;
  }

  if (documentChanges.length > 0) {
    normalized.documentChanges = documentChanges;
  }

  return normalized.changes || normalized.documentChanges ? normalized : null;
}

function uriToWorkspaceRelativePath(uri: string, workspacePath: string): string | undefined {
  try {
    const absolutePath = fileURLToPath(uri);
    const rel = relative(workspacePath, absolutePath);

    if (rel.startsWith("..") || isAbsolute(rel)) {
      return undefined;
    }

    return normalizeWorkspacePath(rel);
  } catch {
    return undefined;
  }
}

function fileEventType(type: CodeFileEvent["type"]): 1 | 2 | 3 {
  if (type === "created") {
    return 1;
  }

  if (type === "deleted") {
    return 3;
  }

  return 2;
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function shouldIgnoreWorkspaceEvent(path: string): boolean {
  return /(^|\/)(node_modules|\.git|out|dist)(\/|$)/.test(path) || /\.tsbuildinfo$/i.test(path);
}

function vueTsServerFallbackResponse(command: string): unknown {
  const normalizedCommand = command.startsWith("_vue:") ? command.slice("_vue:".length) : command;

  if (
    normalizedCommand === "collectExtractProps" ||
    normalizedCommand === "getComponentDirectives" ||
    normalizedCommand === "getComponentNames" ||
    normalizedCommand === "getComponentProps" ||
    normalizedCommand === "getComponentSlots" ||
    normalizedCommand === "getElementAttrs" ||
    normalizedCommand === "getElementNames" ||
    normalizedCommand === "documentHighlights-full"
  ) {
    return [];
  }

  if (normalizedCommand === "encodedSemanticClassifications-full") {
    return {
      spans: [],
      endOfLineState: 0
    };
  }

  if (normalizedCommand === "isRefAtPosition") {
    return false;
  }

  return undefined;
}

function vueProjectContext(workspacePath: string): {
  projectFiles: string[];
  sfcFilesPresent: boolean;
  workspacePath: string;
} {
  const projectFiles = ["tsconfig.json", "jsconfig.json", "package.json"].filter((fileName) =>
    existsSync(resolve(workspacePath, fileName))
  );

  return {
    projectFiles,
    sfcFilesPresent: hasVueFile(workspacePath),
    workspacePath
  };
}

function hasVueFile(directory: string, depth = 0): boolean {
  if (depth > 5) {
    return false;
  }

  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (shouldIgnoreWorkspaceEvent(entry.name)) {
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".vue")) {
        return true;
      }

      if (entry.isDirectory() && hasVueFile(resolve(directory, entry.name), depth + 1)) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

function isDiagnosticSeverity(value: unknown): value is 1 | 2 | 3 | 4 {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function isMarkupContent(value: unknown): value is LspMarkupContent {
  return isRecord(value) && typeof value.value === "string" && typeof value.kind === "string";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function createLanguageServerConfigs(appRoot: string): LanguageServerConfig[] {
  const nodeExecutable = nodeCommand();
  const typescriptSdk = join(appRoot, "node_modules", "typescript", "lib");
  const vueServer = join(
    appRoot,
    "node_modules",
    "@vue",
    "language-server",
    "bin",
    "vue-language-server.js"
  );
  const pyrightServer = join(appRoot, "node_modules", "pyright", "langserver.index.js");

  return [
    {
      languageId: "vue",
      lspLanguageId: "vue",
      label: "Vue / language-tools",
      command: nodeExecutable,
      args: [vueServer, "--stdio", `--tsdk=${typescriptSdk}`],
      cwd: appRoot,
      initializationOptions: {
        typescript: {
          tsdk: typescriptSdk
        }
      },
      workspaceSettings: {
        typescript: {
          tsdk: typescriptSdk,
          preferences: {
            includeCompletionsForImportStatements: true,
            includeCompletionsForModuleExports: true,
            includePackageJsonAutoImports: "auto",
            importModuleSpecifier: "shortest"
          }
        },
        javascript: {
          preferences: {
            includeCompletionsForImportStatements: true,
            includeCompletionsForModuleExports: true,
            includePackageJsonAutoImports: "auto",
            importModuleSpecifier: "shortest"
          }
        },
        vue: {
          complete: {
            casing: {
              props: "autoKebab",
              events: "autoKebab"
            }
          },
          inlayHints: {},
          server: {
            hybridMode: false
          }
        },
        volar: {
          takeOverMode: {
            enabled: false
          }
        }
      }
    },
    {
      languageId: "python",
      lspLanguageId: "python",
      label: "Python / Pyright",
      command: nodeExecutable,
      args: [pyrightServer, "--stdio"],
      cwd: appRoot,
      workspaceSettings: {
        python: {
          analysis: {
            autoImportCompletions: true,
            diagnosticMode: "workspace",
            typeCheckingMode: "basic",
            useLibraryCodeForTypes: true
          }
        },
        pyright: {
          disableOrganizeImports: false
        }
      }
    },
    {
      languageId: "rust",
      lspLanguageId: "rust",
      label: "Rust / rust-analyzer",
      command: "rust-analyzer",
      args: [],
      cwd: appRoot,
      initializationOptions: {
        cargo: {
          allFeatures: true
        },
        checkOnSave: true,
        completion: {
          addCallArgumentSnippets: true,
          addCallParenthesis: true,
          postfix: {
            enable: true
          }
        }
      },
      workspaceSettings: {
        "rust-analyzer": {
          cargo: {
            allFeatures: true
          },
          checkOnSave: true,
          completion: {
            addCallArgumentSnippets: true,
            addCallParenthesis: true,
            postfix: {
              enable: true
            }
          }
        }
      }
    },
    {
      languageId: "go",
      lspLanguageId: "go",
      label: "Go / gopls",
      command: "gopls",
      args: ["serve"],
      cwd: appRoot,
      initializationOptions: {
        analyses: {
          shadow: true,
          unusedparams: true
        },
        completeUnimported: true,
        staticcheck: true,
        usePlaceholders: true
      },
      workspaceSettings: {
        gopls: {
          analyses: {
            shadow: true,
            unusedparams: true
          },
          completeUnimported: true,
          staticcheck: true,
          usePlaceholders: true
        },
        go: {
          useLanguageServer: true
        }
      }
    }
  ];
}

function completionResult(result: unknown): { incomplete: boolean; items: CodeCompletionItem[] } {
  const rawItems = Array.isArray(result)
    ? result
    : Array.isArray((result as CompletionList | undefined)?.items)
      ? (result as CompletionList).items
      : [];
  const incomplete = Boolean((result as CompletionList | undefined)?.isIncomplete);

  return {
    incomplete,
    items: rawItems
      .filter((item): item is LspCompletionItem => Boolean(item?.label))
      .map((item) => completionItem(item))
  };
}

function semanticTokensResult(result: unknown): CodeSemanticTokens | null {
  if (!isRecord(result)) {
    return null;
  }

  const data = Array.isArray(result.data)
    ? result.data.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    : [];

  return {
    resultId: typeof result.resultId === "string" ? result.resultId : undefined,
    data
  };
}

function completionItem(value: unknown, fallback?: CodeCompletionItem): CodeCompletionItem {
  if (!isRecord(value)) {
    return fallback ?? {
      label: "",
      insertText: ""
    };
  }

  const item = value as unknown as LspCompletionItem;
  const label = typeof item.label === "string" ? item.label : fallback?.label ?? "";
  const documentation = completionDocumentation(item.documentation);
  const textEdit = completionTextEdit(item.textEdit);
  const additionalTextEdits = completionTextEdits(item.additionalTextEdits);

  return {
    label,
    labelDetail: item.labelDetails?.detail ?? fallback?.labelDetail,
    labelDescription: item.labelDetails?.description ?? fallback?.labelDescription,
    kind: item.kind ?? fallback?.kind,
    detail: item.detail ?? fallback?.detail,
    documentation: documentation.text ?? fallback?.documentation,
    documentationKind: documentation.kind ?? fallback?.documentationKind,
    insertText: textEdit?.newText ?? item.insertText ?? fallback?.insertText ?? label,
    insertTextFormat: item.insertTextFormat ?? fallback?.insertTextFormat,
    textEdit: textEdit ?? fallback?.textEdit,
    additionalTextEdits: additionalTextEdits ?? fallback?.additionalTextEdits,
    sortText: item.sortText ?? fallback?.sortText,
    filterText: item.filterText ?? fallback?.filterText,
    commitCharacters: item.commitCharacters ?? fallback?.commitCharacters,
    preselect: item.preselect ?? fallback?.preselect,
    tags: item.tags ?? fallback?.tags,
    command: codeCommand(item.command) ?? fallback?.command,
    lspItem: value
  };
}

function completionDocumentation(documentation: LspCompletionItem["documentation"]): {
  text?: string;
  kind?: "markdown" | "plaintext";
} {
  if (typeof documentation === "string") {
    return {
      text: documentation,
      kind: "plaintext"
    };
  }

  if (documentation?.value) {
    return {
      text: documentation.value,
      kind: documentation.kind === "plaintext" ? "plaintext" : "markdown"
    };
  }

  return {};
}

function completionTextEdits(edits: LspTextEdit[] | undefined): CodeCompletionTextEdit[] | undefined {
  if (!Array.isArray(edits)) {
    return undefined;
  }

  return edits
    .map((edit) => completionTextEdit(edit))
    .filter((edit): edit is CodeCompletionTextEdit => Boolean(edit));
}

function completionTextEdit(edit: LspTextEdit | undefined): CodeCompletionTextEdit | undefined {
  if (!edit || typeof edit.newText !== "string") {
    return undefined;
  }

  const textEdit: CodeCompletionTextEdit = {
    newText: edit.newText
  };

  if (isLspRange(edit.range)) {
    textEdit.range = edit.range;
  }

  if (isLspRange(edit.insert)) {
    textEdit.insert = edit.insert;
  }

  if (isLspRange(edit.replace)) {
    textEdit.replace = edit.replace;
  }

  return textEdit;
}

function isLspRange(value: unknown): value is LspRange {
  return (
    isRecord(value) &&
    isRecord(value.start) &&
    isRecord(value.end) &&
    typeof value.start.line === "number" &&
    typeof value.start.character === "number" &&
    typeof value.end.line === "number" &&
    typeof value.end.character === "number"
  );
}

function nodeCommand(): string {
  return process.env.npm_node_execpath || process.env.NODE || "node";
}

function isCommandAvailable(config: LanguageServerConfig): boolean {
  if (config.command === nodeCommand()) {
    return existsSync(config.args[0] ?? "");
  }

  return commandExists(config.command);
}

function commandExists(command: string): boolean {
  if (existsSync(command)) {
    return true;
  }

  const paths = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
    : [""];

  return paths.some((entry) =>
    extensions.some((extension) => existsSync(join(entry, `${command}${extension}`)))
  );
}

function getDottedSetting(settings: Record<string, unknown>, section: string): unknown {
  if (Object.prototype.hasOwnProperty.call(settings, section)) {
    return settings[section];
  }

  const parts = section.split(".");
  let current: unknown = settings;

  for (const part of parts) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return undefined;
    }

    current = current[part];
  }

  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
