/** 工作区文件树中的节点，表示文件或目录。 */
export interface WorkspaceFile {
  path: string;
  kind: "file" | "directory";
}

/** 工作区文本搜索命中的单行结果。 */
export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  text: string;
}

/** Git 状态中的单个文件状态。 */
export interface GitStatusFile {
  path: string;
  index: string;
  workingTree: string;
}

/** Git 状态摘要，由 desktop main 中的 workspace service 生成。 */
export interface GitStatusSummary {
  branch?: string;
  clean: boolean;
  files: GitStatusFile[];
  raw: string;
}

/** 单个文件的 staged 和 unstaged diff 内容。 */
export interface GitFileDiff {
  path: string;
  staged: string;
  unstaged: string;
}

/** Git 分支列表中的分支信息。 */
export interface GitBranch {
  name: string;
  current: boolean;
}

/** Git commit 操作返回的可序列化结果。 */
export interface GitCommitResult {
  ok: boolean;
  output: string;
  commit?: string;
}

/** 终端或一次性命令执行返回的结果。 */
export interface ShellCommandResult {
  ok: boolean;
  output: string;
  exitCode: number;
  cwd?: string;
}

/** 编辑器和语言服务共享的文本位置，行列均按 LSP 约定表示。 */
export interface CodeCompletionPosition {
  line: number;
  character: number;
}

/** 编辑器和语言服务共享的文本范围。 */
export interface CodeCompletionRange {
  start: CodeCompletionPosition;
  end: CodeCompletionPosition;
}

/** 语言服务返回的文本编辑。 */
export interface CodeCompletionTextEdit {
  newText: string;
  range?: CodeCompletionRange;
  insert?: CodeCompletionRange;
  replace?: CodeCompletionRange;
}

/** 语言服务 code action 或 completion item 附带的命令。 */
export interface CodeCommand {
  title?: string;
  command: string;
  arguments?: unknown[];
}

/** Monaco completion provider 可消费的补全项数据。 */
export interface CodeCompletionItem {
  label: string;
  labelDetail?: string;
  labelDescription?: string;
  kind?: number;
  detail?: string;
  documentation?: string;
  documentationKind?: "markdown" | "plaintext";
  insertText?: string;
  insertTextFormat?: 1 | 2;
  textEdit?: CodeCompletionTextEdit;
  additionalTextEdits?: CodeCompletionTextEdit[];
  sortText?: string;
  filterText?: string;
  commitCharacters?: string[];
  preselect?: boolean;
  tags?: number[];
  command?: CodeCommand;
  lspItem?: unknown;
}

/** 请求语言服务提供 completion 的入参。 */
export interface CodeCompletionRequest {
  languageId: string;
  path: string;
  content: string;
  position: CodeCompletionPosition;
  triggerCharacter?: string;
}

/** 请求语言服务解析 completion 详情的入参。 */
export interface CodeCompletionResolveRequest {
  languageId: string;
  path?: string;
  content?: string;
  item: CodeCompletionItem;
}

/** completion 请求返回的补全结果。 */
export interface CodeCompletionResult {
  source: "lsp" | "fallback" | "unavailable";
  server?: string;
  message?: string;
  incomplete?: boolean;
  items: CodeCompletionItem[];
}

/** 语言服务同步文档时使用的基础文档请求。 */
export interface CodeDocumentRequest {
  languageId: string;
  path: string;
  content: string;
}

/** 语言服务保存文档时使用的请求。 */
export interface CodeDocumentSaveRequest {
  languageId: string;
  path: string;
  content?: string;
}

/** 文件创建、变更、删除事件，供语言服务和项目索引刷新使用。 */
export interface CodeFileEvent {
  path: string;
  type: "created" | "changed" | "deleted";
}

/** 请求语言服务提供 hover 信息的入参。 */
export interface CodeHoverRequest extends CodeDocumentRequest {
  position: CodeCompletionPosition;
}

/** hover 返回的展示内容和可选范围。 */
export interface CodeHoverResult {
  contents: Array<{
    value: string;
    kind?: "markdown" | "plaintext";
  }>;
  range?: CodeCompletionRange;
}

/** definition、references 等跳转能力返回的位置。 */
export interface CodeLocation {
  uri: string;
  path?: string;
  range: CodeCompletionRange;
  targetSelectionRange?: CodeCompletionRange;
}

/** workspace edit 中针对单个文档的编辑集合。 */
export interface CodeWorkspaceDocumentEdit {
  path?: string;
  uri?: string;
  edits: CodeCompletionTextEdit[];
}

/** 语言服务返回的跨文件编辑集合。 */
export interface CodeWorkspaceEdit {
  changes?: Record<string, CodeCompletionTextEdit[]>;
  documentChanges?: CodeWorkspaceDocumentEdit[];
}

/** 请求语言服务跳转 definition 的入参。 */
export interface CodeDefinitionRequest extends CodeDocumentRequest {
  position: CodeCompletionPosition;
}

/** 请求语言服务查找 references 的入参。 */
export interface CodeReferencesRequest extends CodeDocumentRequest {
  position: CodeCompletionPosition;
  includeDeclaration?: boolean;
}

/** 语言服务诊断信息，对应 Problems 面板中的问题项。 */
export interface CodeDiagnostic {
  range: CodeCompletionRange;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
  tags?: number[];
}

/** 请求语言服务提供 code action 的入参。 */
export interface CodeActionRequest extends CodeDocumentRequest {
  range: CodeCompletionRange;
  diagnostics?: CodeDiagnostic[];
  only?: string;
}

/** 语言服务返回的 code action。 */
export interface CodeActionResult {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  diagnostics?: CodeDiagnostic[];
  edit?: CodeWorkspaceEdit;
  command?: CodeCommand;
  lspAction?: unknown;
}

/** 请求语言服务解析 code action 详情的入参。 */
export interface CodeActionResolveRequest {
  languageId: string;
  action: CodeActionResult;
}

/** 请求语言服务执行命令的入参。 */
export interface CodeExecuteCommandRequest {
  languageId: string;
  command: CodeCommand;
}

/** 语言服务执行命令后的返回结果。 */
export interface CodeExecuteCommandResult {
  workspaceEdits: CodeWorkspaceEdit[];
  result?: unknown;
}

/** 请求语言服务重命名符号的入参。 */
export interface CodeRenameRequest extends CodeDocumentRequest {
  position: CodeCompletionPosition;
  newName: string;
}

/** 请求语言服务格式化文档或范围的入参。 */
export interface CodeFormatRequest extends CodeDocumentRequest {
  range?: CodeCompletionRange;
  options: {
    tabSize: number;
    insertSpaces: boolean;
  };
}

/** semantic tokens 的原始编码数据。 */
export interface CodeSemanticTokens {
  resultId?: string;
  data: number[];
}

/** semantic tokens 的 token 类型和修饰符表。 */
export interface CodeSemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

/** 请求语言服务提供 semantic tokens 的入参。 */
export interface CodeSemanticTokensRequest extends CodeDocumentRequest {
  previousResultId?: string | null;
  range?: CodeCompletionRange;
}

/** 语言服务推送给 renderer 的诊断事件。 */
export interface CodeDiagnosticsEvent {
  languageId: string;
  uri: string;
  path?: string;
  diagnostics: CodeDiagnostic[];
}

/** 语言服务器运行状态，用于侧边栏和状态展示。 */
export interface LanguageServerStatus {
  languageId: string;
  label: string;
  available: boolean;
  state?: "missing" | "stopped" | "starting" | "ready" | "crashed";
  command: string;
  detail?: string;
  workspace?: string;
  capabilities?: {
    diagnostics?: boolean;
    completion?: boolean;
    hover?: boolean;
    definition?: boolean;
    references?: boolean;
    codeAction?: boolean;
    rename?: boolean;
    formatting?: boolean;
    semanticTokens?: boolean;
  };
}

/** 项目索引中记录的符号，用于符号搜索和命令面板跳转。 */
export interface ProjectIndexSymbol {
  name: string;
  kind: "class" | "function" | "method" | "variable" | "type" | "interface" | "module" | "component";
  path: string;
  line: number;
  column: number;
  languageId: string;
}

/** 当前项目索引的摘要信息。 */
export interface ProjectIndexSummary {
  workspace: string;
  indexedAt: number;
  files: number;
  symbols: number;
  languages: Record<string, number>;
  projectFiles: string[];
}

/** 项目符号搜索请求。 */
export interface ProjectIndexSearchRequest {
  query: string;
  limit?: number;
}

/**
 * 通用 Qoder 错误类。
 *
 * 跨 IPC 传递错误时更推荐使用普通可序列化对象，不要直接依赖 Error 实例。
 */
export class QoderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "QoderError";
  }
}
