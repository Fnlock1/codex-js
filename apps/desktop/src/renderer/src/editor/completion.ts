import type * as Monaco from "monaco-editor";
import type {
  CodeCompletionItem,
  CodeCompletionRange,
  CodeCompletionTextEdit
} from "@qoder-open/shared";
import type { MonacoApi } from "./language-types";
import { executeLanguageCommand } from "./language-features";

const completionLanguageIds = ["vue", "python", "rust", "go"];
const completionUiTimeoutMs = 900;
const automaticCompletionDelayMs = 120;
let registered = false;
let commandsRegistered = false;
const completionSequences = new Map<string, number>();

interface QoderCompletionItem extends Monaco.languages.CompletionItem {
  __qoderItem?: CodeCompletionItem;
  __qoderPath?: string;
  __qoderUri?: string;
}

interface CompletionAutoImportPayload {
  languageId: string;
  path: string;
  uri: string;
  item: CodeCompletionItem;
  hadAdditionalTextEdits: boolean;
}

export function registerLanguageCompletions(monaco: MonacoApi): void {
  if (registered) {
    return;
  }

  registered = true;
  registerCompletionCommands(monaco);

  for (const languageId of completionLanguageIds) {
    monaco.languages.registerCompletionItemProvider(languageId, {
      triggerCharacters: triggerCharactersFor(languageId),
      async provideCompletionItems(model, position, context) {
        const range = wordRange(monaco, model, position);
        const fallbackSuggestions = fallbackItems(monaco, languageId, range);
        const api = window.qoder;
        const requestKey = model.uri.toString();
        const requestSequence = nextCompletionSequence(requestKey);
        const path = pathFromModelUri(model.uri);

        if (!api?.language) {
          return {
            suggestions: fallbackSuggestions
          };
        }

        try {
          if (shouldDebounceCompletion(monaco, languageId, context)) {
            await delay(automaticCompletionDelayMs);

            if (requestSequence !== completionSequences.get(requestKey)) {
              return {
                suggestions: fallbackSuggestions
              };
            }
          }

          const result = await withTimeout(api.language.completions({
            languageId,
            path,
            content: model.getValue(),
            position: {
              line: position.lineNumber - 1,
              character: position.column - 1
            },
            triggerCharacter: context.triggerCharacter
          }), completionTimeoutFor(languageId));

          if (requestSequence !== completionSequences.get(requestKey)) {
            return {
              suggestions: fallbackSuggestions
            };
          }

          const lspSuggestions = result.items.map((item) =>
            toMonacoCompletionItem(monaco, item, range, {
              languageId,
              path,
              uri: model.uri.toString()
            })
          );

          return {
            suggestions: shouldAppendStaticFallback(languageId)
              ? [...lspSuggestions, ...fallbackSuggestions]
              : lspSuggestions,
            incomplete: result.incomplete
          };
        } catch {
          return {
            suggestions: fallbackSuggestions
          };
        }
      },
      async resolveCompletionItem(completionItem, token) {
        const sourceItem = (completionItem as QoderCompletionItem).__qoderItem;
        const api = window.qoder;

        if (!sourceItem || !api?.language?.resolveCompletion || token.isCancellationRequested) {
          return completionItem;
        }

        try {
          const sourcePath = (completionItem as QoderCompletionItem).__qoderPath;
          const sourceUri = (completionItem as QoderCompletionItem).__qoderUri;
          const sourceModel = sourceUri ? monaco.editor.getModel(monaco.Uri.parse(sourceUri)) : undefined;
          const resolvedItem = await api.language.resolveCompletion({
            languageId,
            path: sourcePath,
            content: sourceModel?.getValue(),
            item: sourceItem
          });

          if (token.isCancellationRequested) {
            return completionItem;
          }

          return toMonacoCompletionItem(monaco, resolvedItem, completionItem.range, {
            languageId,
            path: sourcePath ?? "",
            uri: sourceUri ?? ""
          });
        } catch {
          return completionItem;
        }
      }
    });
  }
}

function toMonacoCompletionItem(
  monaco: MonacoApi,
  item: CodeCompletionItem,
  range: Monaco.IRange | Monaco.languages.CompletionItemRanges,
  source: {
    languageId: string;
    path: string;
    uri: string;
  }
): Monaco.languages.CompletionItem {
  const hadAdditionalTextEdits = Boolean(item.additionalTextEdits?.length);
  const completionItem: QoderCompletionItem = {
    label: completionLabel(item),
    kind: mapCompletionKind(monaco, item.kind),
    detail: item.detail,
    documentation: completionDocumentation(item),
    insertText: item.insertText || item.label,
    insertTextRules: item.insertTextFormat === 2
      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
      : undefined,
    filterText: item.filterText,
    sortText: item.sortText,
    preselect: item.preselect,
    tags: item.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
    commitCharacters: item.commitCharacters,
    additionalTextEdits: item.additionalTextEdits
      ?.map((edit) => toMonacoTextEdit(monaco, edit))
      .filter((edit): edit is Monaco.editor.ISingleEditOperation => Boolean(edit)),
    range: completionRange(monaco, item.textEdit, range),
    command: {
      id: "qoder.applyCompletionAutoImport",
      title: "Apply auto import",
      arguments: [
        {
          languageId: source.languageId,
          path: source.path,
          uri: source.uri,
          item,
          hadAdditionalTextEdits
        } satisfies CompletionAutoImportPayload
      ]
    }
  };

  completionItem.__qoderItem = item;
  completionItem.__qoderPath = source.path;
  completionItem.__qoderUri = source.uri;
  return completionItem;
}

function registerCompletionCommands(monaco: MonacoApi): void {
  if (commandsRegistered) {
    return;
  }

  commandsRegistered = true;
  monaco.editor.registerCommand("qoder.applyCompletionAutoImport", (_accessor, payload: unknown) => {
    if (!isCompletionAutoImportPayload(payload)) {
      return;
    }

    void applyCompletionAutoImport(monaco, payload);
  });
}

async function applyCompletionAutoImport(
  monaco: MonacoApi,
  payload: CompletionAutoImportPayload
): Promise<void> {
  const api = window.qoder;
  let item = payload.item;

  // Monaco applies inline additionalTextEdits together with the accepted completion.
  // If the user accepted before resolve finished, resolve once after insertion and
  // apply the import-only edits directly to the current model.
  await delay(0);

  if (!payload.hadAdditionalTextEdits && api?.language?.resolveCompletion) {
    const model = modelForUri(monaco, payload.uri);
    const resolvedItem = await withTimeout(api.language.resolveCompletion({
      languageId: payload.languageId,
      path: payload.path,
      content: model?.getValue(),
      item
    }), completionResolveTimeoutFor(payload.languageId)).catch(() => item);

    item = resolvedItem;

    if (resolvedItem.additionalTextEdits?.length && model) {
      applyAdditionalTextEdits(monaco, model, resolvedItem.additionalTextEdits);
    }
  }

  if (item.command) {
    await executeLanguageCommand(
      payload.languageId,
      item.command,
      item.command.title ?? `Completion command: ${item.label}`
    ).catch(() => undefined);
  }
}

function applyAdditionalTextEdits(
  monaco: MonacoApi,
  model: Monaco.editor.ITextModel,
  edits: CodeCompletionTextEdit[]
): void {
  const operations = edits
    .map((edit) => toMonacoTextEdit(monaco, edit))
    .filter((edit): edit is Monaco.editor.ISingleEditOperation => Boolean(edit));

  if (operations.length === 0) {
    return;
  }

  model.pushEditOperations([], operations, () => null);
}

function modelForUri(monaco: MonacoApi, uri: string): Monaco.editor.ITextModel | undefined {
  if (!uri) {
    return undefined;
  }

  try {
    return monaco.editor.getModel(monaco.Uri.parse(uri)) ?? undefined;
  } catch {
    return undefined;
  }
}

function isCompletionAutoImportPayload(value: unknown): value is CompletionAutoImportPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "languageId" in value &&
    typeof value.languageId === "string" &&
    "path" in value &&
    typeof value.path === "string" &&
    "uri" in value &&
    typeof value.uri === "string" &&
    "item" in value &&
    typeof value.item === "object" &&
    value.item !== null &&
    "hadAdditionalTextEdits" in value &&
    typeof value.hadAdditionalTextEdits === "boolean"
  );
}

function nextCompletionSequence(requestKey: string): number {
  const nextSequence = (completionSequences.get(requestKey) ?? 0) + 1;
  completionSequences.set(requestKey, nextSequence);
  return nextSequence;
}

function shouldDebounceCompletion(
  monaco: MonacoApi,
  languageId: string,
  context: Monaco.languages.CompletionContext
): boolean {
  return languageId === "vue" && context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerForIncompleteCompletions;
}

function completionTimeoutFor(languageId: string): number {
  return languageId === "vue" ? completionUiTimeoutMs : completionUiTimeoutMs * 2;
}

function completionResolveTimeoutFor(languageId: string): number {
  return languageId === "vue" ? 1_500 : 2_500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Completion request timed out.")), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function completionLabel(
  item: CodeCompletionItem
): string | Monaco.languages.CompletionItemLabel {
  if (!item.labelDetail && !item.labelDescription) {
    return item.label;
  }

  return {
    label: item.label,
    detail: item.labelDetail,
    description: item.labelDescription
  };
}

function completionDocumentation(
  item: CodeCompletionItem
): string | Monaco.IMarkdownString | undefined {
  if (!item.documentation) {
    return undefined;
  }

  return item.documentationKind === "markdown"
    ? {
        value: item.documentation
      }
    : item.documentation;
}

function completionRange(
  monaco: MonacoApi,
  edit: CodeCompletionTextEdit | undefined,
  fallbackRange: Monaco.IRange | Monaco.languages.CompletionItemRanges
): Monaco.IRange | Monaco.languages.CompletionItemRanges {
  if (edit?.insert && edit.replace) {
    return {
      insert: toMonacoRange(monaco, edit.insert),
      replace: toMonacoRange(monaco, edit.replace)
    };
  }

  if (edit?.range) {
    return toMonacoRange(monaco, edit.range);
  }

  return fallbackRange;
}

function toMonacoTextEdit(
  monaco: MonacoApi,
  edit: CodeCompletionTextEdit
): Monaco.editor.ISingleEditOperation | undefined {
  if (!edit.range) {
    return undefined;
  }

  return {
    range: toMonacoRange(monaco, edit.range),
    text: edit.newText,
    forceMoveMarkers: true
  };
}

function toMonacoRange(monaco: MonacoApi, range: CodeCompletionRange): Monaco.Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1
  );
}

function fallbackItems(
  monaco: MonacoApi,
  languageId: string,
  range: Monaco.IRange
): Monaco.languages.CompletionItem[] {
  if (!shouldAppendStaticFallback(languageId)) {
    return [];
  }

  const entries = fallbackEntries[languageId] ?? [];

  return entries.map((entry, index) => ({
    label: entry.label,
    kind: fallbackKind(monaco, entry.kind),
    detail: entry.detail,
    documentation: entry.documentation,
    insertText: entry.insertText ?? entry.label,
    insertTextRules: entry.snippet
      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
      : undefined,
    sortText: `zz_${String(index).padStart(3, "0")}_${entry.label}`,
    range
  }));
}

function shouldAppendStaticFallback(languageId: string): boolean {
  // Vue completions must come from the official vuejs/language-tools server.
  // Static Vue snippets/macros look helpful, but they hide broken language server
  // wiring and quickly fall behind real Vue / Volar behavior.
  return languageId !== "vue";
}

function wordRange(
  monaco: MonacoApi,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position
): Monaco.IRange {
  const word = model.getWordUntilPosition(position);

  return new monaco.Range(
    position.lineNumber,
    word.startColumn,
    position.lineNumber,
    word.endColumn
  );
}

function pathFromModelUri(uri: Monaco.Uri): string {
  return decodeURIComponent(uri.path.replace(/^\//, "")) || "untitled";
}

function triggerCharactersFor(languageId: string): string[] {
  if (languageId === "vue") {
    return [".", ":", "@", "<", "/", '"', "'", "-"];
  }

  if (languageId === "python") {
    return [".", "@", "_"];
  }

  if (languageId === "rust") {
    return [".", ":", "!", "_"];
  }

  return [".", "_"];
}

function mapCompletionKind(monaco: MonacoApi, kind?: number): Monaco.languages.CompletionItemKind {
  const kinds = monaco.languages.CompletionItemKind;
  const map: Record<number, Monaco.languages.CompletionItemKind> = {
    1: kinds.Text,
    2: kinds.Method,
    3: kinds.Function,
    4: kinds.Constructor,
    5: kinds.Field,
    6: kinds.Variable,
    7: kinds.Class,
    8: kinds.Interface,
    9: kinds.Module,
    10: kinds.Property,
    11: kinds.Unit,
    12: kinds.Value,
    13: kinds.Enum,
    14: kinds.Keyword,
    15: kinds.Snippet,
    16: kinds.Color,
    17: kinds.File,
    18: kinds.Reference,
    20: kinds.EnumMember,
    21: kinds.Constant,
    22: kinds.Struct,
    23: kinds.Event,
    24: kinds.Operator,
    25: kinds.TypeParameter
  };

  return kind ? map[kind] ?? kinds.Text : kinds.Text;
}

interface FallbackEntry {
  label: string;
  insertText?: string;
  detail?: string;
  documentation?: string;
  kind: "keyword" | "snippet";
  snippet?: boolean;
}

const fallbackEntries: Record<string, FallbackEntry[]> = {
  python: [
    snippet("def", "def ${1:name}(${2:args}):\\n    $0", "Python function"),
    snippet("class", "class ${1:Name}:\\n    def __init__(self):\\n        $0", "Python class"),
    snippet("if __name__", 'if __name__ == "__main__":\\n    $0', "Python entry point"),
    keyword("import", "Import module"),
    keyword("from", "Import from module"),
    keyword("print", "Print value"),
    keyword("len", "Length helper"),
    keyword("range", "Range iterator"),
    keyword("enumerate", "Enumerate iterator"),
    keyword("dataclass", "dataclasses.dataclass"),
    keyword("asyncio", "Async IO package")
  ],
  rust: [
    snippet("fn", "fn ${1:name}(${2:args}) {\\n    $0\\n}", "Rust function"),
    snippet("main", "fn main() {\\n    $0\\n}", "Rust main function"),
    snippet("struct", "struct ${1:Name} {\\n    $0\\n}", "Rust struct"),
    snippet("impl", "impl ${1:Type} {\\n    $0\\n}", "Rust impl block"),
    keyword("let", "Local binding"),
    keyword("mut", "Mutable binding"),
    keyword("match", "Pattern matching"),
    keyword("Option", "Optional value"),
    keyword("Result", "Fallible value"),
    keyword("Some", "Option some variant"),
    keyword("None", "Option none variant"),
    keyword("Ok", "Result ok variant"),
    keyword("Err", "Result error variant"),
    keyword("println!", "Print line macro"),
    keyword("vec!", "Vector macro")
  ],
  go: [
    snippet("func", "func ${1:name}(${2:args}) ${3:error} {\\n\\t$0\\n}", "Go function"),
    snippet("main", "func main() {\\n\\t$0\\n}", "Go main function"),
    snippet("struct", "type ${1:Name} struct {\\n\\t$0\\n}", "Go struct type"),
    snippet("interface", "type ${1:Name} interface {\\n\\t$0\\n}", "Go interface type"),
    keyword("package", "Package declaration"),
    keyword("import", "Import package"),
    keyword("fmt.Println", "Print line"),
    keyword("make", "Allocate slice/map/channel"),
    keyword("append", "Append to slice"),
    keyword("context.Context", "Context type"),
    keyword("defer", "Defer statement"),
    keyword("go", "Start goroutine"),
    keyword("range", "Range loop")
  ]
};

function snippet(label: string, insertText: string, documentation: string): FallbackEntry {
  return {
    label,
    insertText,
    documentation,
    detail: "Qoder snippet",
    kind: "snippet",
    snippet: true
  };
}

function keyword(label: string, documentation: string): FallbackEntry {
  return {
    label,
    documentation,
    detail: "Qoder fallback completion",
    kind: "keyword"
  };
}

function fallbackKind(
  monaco: MonacoApi,
  kind: FallbackEntry["kind"]
): Monaco.languages.CompletionItemKind {
  return kind === "snippet"
    ? monaco.languages.CompletionItemKind.Snippet
    : monaco.languages.CompletionItemKind.Keyword;
}
