export interface WorkspaceFile {
  path: string;
  kind: "file" | "directory";
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface GitStatusFile {
  path: string;
  index: string;
  workingTree: string;
}

export interface GitStatusSummary {
  branch?: string;
  clean: boolean;
  files: GitStatusFile[];
  raw: string;
}

export interface GitFileDiff {
  path: string;
  staged: string;
  unstaged: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
}

export interface GitCommitResult {
  ok: boolean;
  output: string;
  commit?: string;
}

export interface ShellCommandResult {
  ok: boolean;
  output: string;
  exitCode: number;
  cwd?: string;
}

export interface CodeCompletionPosition {
  line: number;
  character: number;
}

export interface CodeCompletionRange {
  start: CodeCompletionPosition;
  end: CodeCompletionPosition;
}

export interface CodeCompletionTextEdit {
  newText: string;
  range?: CodeCompletionRange;
  insert?: CodeCompletionRange;
  replace?: CodeCompletionRange;
}

export interface CodeCommand {
  title?: string;
  command: string;
  arguments?: unknown[];
}

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

export interface CodeCompletionRequest {
  languageId: string;
  path: string;
  content: string;
  position: CodeCompletionPosition;
  triggerCharacter?: string;
}

export interface CodeCompletionResolveRequest {
  languageId: string;
  path?: string;
  content?: string;
  item: CodeCompletionItem;
}

export interface CodeCompletionResult {
  source: "lsp" | "fallback" | "unavailable";
  server?: string;
  message?: string;
  incomplete?: boolean;
  items: CodeCompletionItem[];
}

export interface CodeDocumentRequest {
  languageId: string;
  path: string;
  content: string;
}

export interface CodeDocumentSaveRequest {
  languageId: string;
  path: string;
  content?: string;
}

export interface CodeFileEvent {
  path: string;
  type: "created" | "changed" | "deleted";
}

export interface CodeHoverRequest extends CodeDocumentRequest {
  position: CodeCompletionPosition;
}

export interface CodeHoverResult {
  contents: Array<{
    value: string;
    kind?: "markdown" | "plaintext";
  }>;
  range?: CodeCompletionRange;
}

export interface CodeLocation {
  uri: string;
  path?: string;
  range: CodeCompletionRange;
  targetSelectionRange?: CodeCompletionRange;
}

export interface CodeWorkspaceDocumentEdit {
  path?: string;
  uri?: string;
  edits: CodeCompletionTextEdit[];
}

export interface CodeWorkspaceEdit {
  changes?: Record<string, CodeCompletionTextEdit[]>;
  documentChanges?: CodeWorkspaceDocumentEdit[];
}

export interface CodeDefinitionRequest extends CodeDocumentRequest {
  position: CodeCompletionPosition;
}

export interface CodeReferencesRequest extends CodeDocumentRequest {
  position: CodeCompletionPosition;
  includeDeclaration?: boolean;
}

export interface CodeDiagnostic {
  range: CodeCompletionRange;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
  tags?: number[];
}

export interface CodeActionRequest extends CodeDocumentRequest {
  range: CodeCompletionRange;
  diagnostics?: CodeDiagnostic[];
  only?: string;
}

export interface CodeActionResult {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  diagnostics?: CodeDiagnostic[];
  edit?: CodeWorkspaceEdit;
  command?: CodeCommand;
  lspAction?: unknown;
}

export interface CodeActionResolveRequest {
  languageId: string;
  action: CodeActionResult;
}

export interface CodeExecuteCommandRequest {
  languageId: string;
  command: CodeCommand;
}

export interface CodeExecuteCommandResult {
  workspaceEdits: CodeWorkspaceEdit[];
  result?: unknown;
}

export interface CodeRenameRequest extends CodeDocumentRequest {
  position: CodeCompletionPosition;
  newName: string;
}

export interface CodeFormatRequest extends CodeDocumentRequest {
  range?: CodeCompletionRange;
  options: {
    tabSize: number;
    insertSpaces: boolean;
  };
}

export interface CodeSemanticTokens {
  resultId?: string;
  data: number[];
}

export interface CodeSemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

export interface CodeSemanticTokensRequest extends CodeDocumentRequest {
  previousResultId?: string | null;
  range?: CodeCompletionRange;
}

export interface CodeDiagnosticsEvent {
  languageId: string;
  uri: string;
  path?: string;
  diagnostics: CodeDiagnostic[];
}

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

export interface ProjectIndexSymbol {
  name: string;
  kind: "class" | "function" | "method" | "variable" | "type" | "interface" | "module" | "component";
  path: string;
  line: number;
  column: number;
  languageId: string;
}

export interface ProjectIndexSummary {
  workspace: string;
  indexedAt: number;
  files: number;
  symbols: number;
  languages: Record<string, number>;
  projectFiles: string[];
}

export interface ProjectIndexSearchRequest {
  query: string;
  limit?: number;
}

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
