import type * as Monaco from "monaco-editor";
import type {
  CodeActionResult,
  CodeCommand,
  CodeCompletionRange,
  CodeCompletionTextEdit,
  CodeDiagnostic,
  CodeDiagnosticsEvent,
  CodeLocation,
  CodeSemanticTokensLegend,
  CodeWorkspaceEdit
} from "@qoder-open/shared";
import type { MonacoApi } from "./language-types";
import { ensureLanguage } from "./language-registry";

const featureLanguageIds = ["vue", "python", "rust", "go"];
const semanticTokenLanguageIds: string[] = [];
const markerOwner = "qoder-lsp";
const syncDelayMs = 250;
const semanticTokenCooldownMs = 3_000;
type SyncTimer = ReturnType<typeof setTimeout>;
const semanticTokenLegend: CodeSemanticTokensLegend = {
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

let registered = false;
let commandsRegistered = false;
let removeDiagnosticsListener: (() => void) | undefined;
const pendingDiagnostics = new Map<string, CodeDiagnosticsEvent>();
const syncTimers = new Map<string, SyncTimer>();
const semanticTokenCooldownUntil = new Map<string, number>();
let workspaceEditApplyHandler: WorkspaceEditApplyHandler | undefined;

interface QoderCodeAction extends Monaco.languages.CodeAction {
  __qoderAction?: CodeActionResult;
}

export interface WorkspaceEditApplyOptions {
  title?: string;
  source?: string;
}

export type WorkspaceEditApplyHandler = (
  edit: CodeWorkspaceEdit,
  options?: WorkspaceEditApplyOptions
) => Promise<unknown> | unknown;

export function setWorkspaceEditApplyHandler(handler: WorkspaceEditApplyHandler | undefined): void {
  workspaceEditApplyHandler = handler;
}

export async function applyLanguageWorkspaceEdit(
  edit: CodeWorkspaceEdit,
  options?: WorkspaceEditApplyOptions
): Promise<unknown> {
  if (!workspaceEditApplyHandler) {
    throw new Error("Workspace edit handler is not registered.");
  }

  return workspaceEditApplyHandler(edit, options);
}

export function registerLanguageFeatures(monaco: MonacoApi): void {
  if (registered) {
    return;
  }

  registered = true;
  registerLanguageCommands(monaco);
  registerDiagnostics(monaco);

  for (const languageId of featureLanguageIds) {
    if (semanticTokenLanguageIds.includes(languageId)) {
      monaco.languages.registerDocumentRangeSemanticTokensProvider(languageId, {
        getLegend() {
          return semanticTokenLegend;
        },
        async provideDocumentRangeSemanticTokens(model, range, token) {
          const api = window.qoder;
          const path = pathFromModelUri(model.uri);

          if (!api?.language?.semanticTokens || token.isCancellationRequested || isSemanticTokenCoolingDown(path)) {
            return null;
          }

          try {
            const result = await api.language.semanticTokens({
              languageId,
              path,
              content: model.getValue(),
              range: fromMonacoRange(range)
            });

            if (!result || token.isCancellationRequested) {
              return null;
            }

            return {
              resultId: result.resultId,
              data: Uint32Array.from(result.data)
            };
          } catch {
            semanticTokenCooldownUntil.set(path, Date.now() + semanticTokenCooldownMs);
            return null;
          }
        }
      });
    }

    monaco.languages.registerHoverProvider(languageId, {
      async provideHover(model, position, token) {
        const api = window.qoder;

        if (!api?.language?.hover || token.isCancellationRequested) {
          return null;
        }

        try {
          const result = await api.language.hover({
            languageId,
            path: pathFromModelUri(model.uri),
            content: model.getValue(),
            position: lspPosition(position)
          });

          if (!result || token.isCancellationRequested) {
            return null;
          }

          return {
            contents: result.contents.map((content) => ({
              value: content.value,
              isTrusted: false
            })),
            range: result.range ? toMonacoRange(monaco, result.range) : undefined
          };
        } catch {
          return null;
        }
      }
    });

    monaco.languages.registerDefinitionProvider(languageId, {
      async provideDefinition(model, position, token) {
        const api = window.qoder;

        if (token.isCancellationRequested) {
          return [];
        }

        try {
          const locations = api?.language?.definition
            ? await api.language.definition({
                languageId,
                path: pathFromModelUri(model.uri),
                content: model.getValue(),
                position: lspPosition(position)
              })
            : [];

          if (token.isCancellationRequested) {
            return [];
          }

          if (locations.length > 0) {
            await ensureLocationModels(monaco, locations);
            return locations.map((location) => toMonacoLocation(monaco, location));
          }

          return languageId === "vue" ? vueLocalDefinitions(monaco, model, position) : [];
        } catch {
          return languageId === "vue" ? vueLocalDefinitions(monaco, model, position) : [];
        }
      }
    });

    monaco.languages.registerReferenceProvider(languageId, {
      async provideReferences(model, position, context, token) {
        const api = window.qoder;

        if (!api?.language?.references || token.isCancellationRequested) {
          return [];
        }

        try {
          const locations = await api.language.references({
            languageId,
            path: pathFromModelUri(model.uri),
            content: model.getValue(),
            position: lspPosition(position),
            includeDeclaration: context.includeDeclaration
          });

          if (token.isCancellationRequested) {
            return [];
          }

          await ensureLocationModels(monaco, locations.slice(0, 80));
          return locations.map((location) => toMonacoLocation(monaco, location));
        } catch {
          return [];
        }
      }
    });

    monaco.languages.registerCodeActionProvider(
      languageId,
      {
        async provideCodeActions(model, range, context, token) {
          const api = window.qoder;

          if (!api?.language?.codeActions || token.isCancellationRequested) {
            return {
              actions: [],
              dispose: () => undefined
            };
          }

          if (shouldSkipCodeActions(monaco, languageId, context)) {
            return {
              actions: [],
              dispose: () => undefined
            };
          }

          try {
            const actions = await api.language.codeActions({
              languageId,
              path: pathFromModelUri(model.uri),
              content: model.getValue(),
              range: fromMonacoRange(range),
              diagnostics: context.markers.map((marker) => diagnosticFromMarker(marker)),
              only: context.only
            });

            if (token.isCancellationRequested) {
              return {
                actions: [],
                dispose: () => undefined
              };
            }

            return {
              actions: actions.map((action) => toMonacoCodeAction(monaco, action, languageId)),
              dispose: () => undefined
            };
          } catch {
            return {
              actions: [],
              dispose: () => undefined
            };
          }
        },
        async resolveCodeAction(action, token) {
          const sourceAction = (action as QoderCodeAction).__qoderAction;
          const api = window.qoder;

          if (!sourceAction || !api?.language?.resolveCodeAction || token.isCancellationRequested) {
            return action;
          }

          try {
            const resolved = await api.language.resolveCodeAction({
              languageId,
              action: sourceAction
            });

            if (token.isCancellationRequested) {
              return action;
            }

            return toMonacoCodeAction(monaco, resolved, languageId);
          } catch {
            return action;
          }
        }
      },
      {
        providedCodeActionKinds: [
          "quickfix",
          "refactor",
          "source",
          "source.addMissingImports",
          "source.addMissingImports.ts",
          "source.fixAll",
          "source.organizeImports"
        ]
      }
    );

    monaco.languages.registerRenameProvider(languageId, {
      async provideRenameEdits(model, position, newName, token) {
        const api = window.qoder;

        if (!api?.language?.rename || token.isCancellationRequested) {
          return {
            edits: [],
            rejectReason: "Rename is not available."
          };
        }

        try {
          const edit = await api.language.rename({
            languageId,
            path: pathFromModelUri(model.uri),
            content: model.getValue(),
            position: lspPosition(position),
            newName
          });

          if (!edit || token.isCancellationRequested) {
            return {
              edits: [],
              rejectReason: "The language server did not return rename edits."
            };
          }

          return toMonacoWorkspaceEdit(monaco, edit, "Rename symbol");
        } catch (error) {
          return {
            edits: [],
            rejectReason: error instanceof Error ? error.message : "Rename failed."
          };
        }
      }
    });

    monaco.languages.registerDocumentFormattingEditProvider(languageId, {
      displayName: "Qoder LSP",
      async provideDocumentFormattingEdits(model, options, token) {
        const api = window.qoder;

        if (!api?.language?.format || token.isCancellationRequested) {
          return [];
        }

        try {
          const edits = await api.language.format({
            languageId,
            path: pathFromModelUri(model.uri),
            content: model.getValue(),
            options: {
              tabSize: options.tabSize,
              insertSpaces: options.insertSpaces
            }
          });

          return token.isCancellationRequested ? [] : edits.map((edit) => toMonacoTextEdit(monaco, edit));
        } catch {
          return [];
        }
      }
    });

    monaco.languages.registerDocumentRangeFormattingEditProvider(languageId, {
      displayName: "Qoder LSP",
      async provideDocumentRangeFormattingEdits(model, range, options, token) {
        const api = window.qoder;

        if (!api?.language?.format || token.isCancellationRequested) {
          return [];
        }

        try {
          const edits = await api.language.format({
            languageId,
            path: pathFromModelUri(model.uri),
            content: model.getValue(),
            range: fromMonacoRange(range),
            options: {
              tabSize: options.tabSize,
              insertSpaces: options.insertSpaces
            }
          });

          return token.isCancellationRequested ? [] : edits.map((edit) => toMonacoTextEdit(monaco, edit));
        } catch {
          return [];
        }
      }
    });
  }
}

export async function executeLanguageCommand(
  languageId: string,
  command: CodeCommand,
  title = command.title ?? "Language command"
): Promise<void> {
  const api = window.qoder;

  if (!api?.language?.executeCommand) {
    return;
  }

  const result = await api.language.executeCommand({
    languageId,
    command
  });

  for (const edit of result.workspaceEdits) {
    await applyLanguageWorkspaceEdit(edit, {
      title,
      source: "lsp-command"
    });
  }
}

function registerLanguageCommands(monaco: MonacoApi): void {
  if (commandsRegistered) {
    return;
  }

  commandsRegistered = true;
  monaco.editor.registerCommand(
    "qoder.executeLanguageCommand",
    (_accessor, languageId: unknown, command: unknown, title: unknown) => {
      if (typeof languageId !== "string" || !isCodeCommand(command)) {
        return;
      }

      void executeLanguageCommand(
        languageId,
        command,
        typeof title === "string" ? title : command.title
      );
    }
  );
}

function isCodeCommand(value: unknown): value is CodeCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    "command" in value &&
    typeof value.command === "string"
  );
}

function shouldSkipCodeActions(
  monaco: MonacoApi,
  languageId: string,
  context: Monaco.languages.CodeActionContext
): boolean {
  return (
    languageId === "vue" &&
    context.trigger === monaco.languages.CodeActionTriggerType.Auto &&
    !context.only
  );
}

export function syncLanguageModel(model: Monaco.editor.ITextModel, delay = syncDelayMs): void {
  const languageId = model.getLanguageId();

  if (!featureLanguageIds.includes(languageId)) {
    return;
  }

  const key = model.uri.toString();
  const existingTimer = syncTimers.get(key);

  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  syncTimers.set(
    key,
    setTimeout(() => {
      syncTimers.delete(key);
      void syncLanguageModelNow(model);
    }, delay)
  );
}

export async function syncLanguageModelNow(model: Monaco.editor.ITextModel): Promise<void> {
  const api = window.qoder;
  const languageId = model.getLanguageId();

  if (!api?.language?.syncDocument || !featureLanguageIds.includes(languageId)) {
    return;
  }

  await api.language.syncDocument({
    languageId,
    path: pathFromModelUri(model.uri),
    content: model.getValue()
  });
}

function registerDiagnostics(monaco: MonacoApi): void {
  const api = window.qoder;

  if (!api?.language?.onDiagnostics) {
    return;
  }

  removeDiagnosticsListener = api.language.onDiagnostics((event) => {
    const key = event.path ?? event.uri;
    pendingDiagnostics.set(key, event);
    applyDiagnostics(monaco, event);
  });

  monaco.editor.onDidCreateModel((model) => {
    const path = pathFromModelUri(model.uri);
    const event = pendingDiagnostics.get(path);

    if (event) {
      applyDiagnostics(monaco, event);
    }
  });

  window.addEventListener("beforeunload", () => {
    removeDiagnosticsListener?.();
    removeDiagnosticsListener = undefined;
  });
}

function applyDiagnostics(monaco: MonacoApi, event: CodeDiagnosticsEvent): void {
  if (!event.path) {
    return;
  }

  const model = monaco.editor.getModel(modelUri(monaco, event.path));

  if (!model) {
    return;
  }

  monaco.editor.setModelMarkers(
    model,
    markerOwner,
    event.diagnostics.map((diagnostic) => toMarkerData(monaco, diagnostic))
  );
}

function isSemanticTokenCoolingDown(path: string): boolean {
  const until = semanticTokenCooldownUntil.get(path);

  if (!until) {
    return false;
  }

  if (until <= Date.now()) {
    semanticTokenCooldownUntil.delete(path);
    return false;
  }

  return true;
}

function toMarkerData(monaco: MonacoApi, diagnostic: CodeDiagnostic): Monaco.editor.IMarkerData {
  const code = diagnostic.code !== undefined ? String(diagnostic.code) : undefined;

  return {
    ...toMarkerRange(diagnostic.range),
    severity: markerSeverity(monaco, diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source,
    code,
    tags: markerTags(monaco, diagnostic.tags)
  };
}

async function ensureLocationModels(monaco: MonacoApi, locations: CodeLocation[]): Promise<void> {
  const api = window.qoder;
  const uniquePaths = Array.from(
    new Set(locations.map((location) => location.path).filter((path): path is string => Boolean(path)))
  );

  for (const path of uniquePaths.slice(0, 24)) {
    const uri = modelUri(monaco, path);

    if (monaco.editor.getModel(uri) || !api?.workspace?.readFile) {
      continue;
    }

    try {
      const result = await api.workspace.readFile(path);
      const languageId = await ensureLanguage(monaco, path);
      monaco.editor.createModel(result.content, languageId, uri);
    } catch {
      // Cross-file navigation should not fail just because one target cannot be opened.
    }
  }
}

function toMonacoLocation(monaco: MonacoApi, location: CodeLocation): Monaco.languages.Location {
  return {
    uri: location.path ? modelUri(monaco, location.path) : monaco.Uri.parse(location.uri),
    range: toMonacoRange(monaco, location.targetSelectionRange ?? location.range)
  };
}

function vueLocalDefinitions(
  monaco: MonacoApi,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position
): Monaco.languages.Location[] {
  const word = model.getWordAtPosition(position)?.word;

  if (!word || !isInsideVueTemplate(model, position.lineNumber)) {
    return [];
  }

  const content = model.getValue();
  const script = scriptSetupBlock(content);
  const offset = script
    ? findVueScriptSymbolOffset(script.content, word)
    : findVueScriptSymbolOffset(content, word);

  if (offset === undefined) {
    return [];
  }

  const target = model.getPositionAt((script?.startOffset ?? 0) + offset);

  return [
    {
      uri: model.uri,
      range: new monaco.Range(
        target.lineNumber,
        target.column,
        target.lineNumber,
        target.column + word.length
      )
    }
  ];
}

function isInsideVueTemplate(model: Monaco.editor.ITextModel, lineNumber: number): boolean {
  const before = model.getValueInRange({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: lineNumber,
    endColumn: model.getLineMaxColumn(lineNumber)
  });
  const open = before.lastIndexOf("<template");
  const close = before.lastIndexOf("</template>");

  return open >= 0 && open > close;
}

function scriptSetupBlock(content: string): { content: string; startOffset: number } | undefined {
  const match = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(content);

  if (!match || match.index === undefined) {
    return undefined;
  }

  return {
    content: match[1],
    startOffset: match.index + match[0].indexOf(match[1])
  };
}

function findVueScriptSymbolOffset(content: string, symbol: string): number | undefined {
  const escaped = escapeRegExp(symbol);
  const patterns = [
    new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b`),
    new RegExp(`\\bfunction\\s+${escaped}\\b`),
    new RegExp(`\\b${escaped}\\s*[:=]`),
    new RegExp(`\\b${escaped}\\b`)
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(content);

    if (match?.index !== undefined) {
      const symbolIndex = match[0].search(new RegExp(`\\b${escaped}\\b`));
      return match.index + Math.max(0, symbolIndex);
    }
  }

  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toMonacoCodeAction(
  monaco: MonacoApi,
  action: CodeActionResult,
  languageId: string
): Monaco.languages.CodeAction {
  const monacoAction: QoderCodeAction = {
    title: action.title,
    kind: action.kind,
    isPreferred: action.isPreferred,
    diagnostics: action.diagnostics?.map((diagnostic) => toMarkerData(monaco, diagnostic)),
    edit: action.edit ? toMonacoWorkspaceEdit(monaco, action.edit, action.title) : undefined,
    command: action.command
      ? {
          id: "qoder.executeLanguageCommand",
          title: action.command.title ?? action.title,
          arguments: [languageId, action.command, action.title]
        }
      : undefined
  };

  monacoAction.__qoderAction = action;
  return monacoAction;
}

function toMonacoWorkspaceEdit(
  monaco: MonacoApi,
  edit: CodeWorkspaceEdit,
  title = "Apply workspace edit"
): Monaco.languages.WorkspaceEdit {
  let applied = false;
  let appliedResult: UndoableWorkspaceEditResult | undefined;
  const customEdit: Monaco.languages.ICustomEdit = {
    resource: firstWorkspaceEditUri(monaco, edit),
    metadata: {
      label: title,
      needsConfirmation: false
    },
    async redo() {
      if (applied) {
        return;
      }

      if (!workspaceEditApplyHandler) {
        throw new Error("Workspace edit handler is not registered.");
      }

      applied = true;
      const result = await workspaceEditApplyHandler(edit, {
        title,
        source: "lsp"
      });

      if (isUndoableWorkspaceEditResult(result)) {
        appliedResult = result;
      }
    },
    async undo() {
      await appliedResult?.undo();
      applied = false;
    }
  };

  return {
    edits: [customEdit]
  };
}

interface UndoableWorkspaceEditResult {
  undo: () => Promise<void> | void;
}

function isUndoableWorkspaceEditResult(value: unknown): value is UndoableWorkspaceEditResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "undo" in value &&
    typeof value.undo === "function"
  );
}

function firstWorkspaceEditUri(monaco: MonacoApi, edit: CodeWorkspaceEdit): Monaco.Uri {
  const changedPath = Object.keys(edit.changes ?? {})[0];

  if (changedPath) {
    return modelUri(monaco, changedPath);
  }

  for (const documentChange of edit.documentChanges ?? []) {
    if (documentChange.path) {
      return modelUri(monaco, documentChange.path);
    }

    if (documentChange.uri) {
      return monaco.Uri.parse(documentChange.uri);
    }
  }

  return modelUri(monaco, "workspace-edit");
}

function toMonacoTextEdit(monaco: MonacoApi, edit: CodeCompletionTextEdit): Monaco.languages.TextEdit {
  return {
    range: edit.range ? toMonacoRange(monaco, edit.range) : new monaco.Range(1, 1, 1, 1),
    text: edit.newText
  };
}

function toMarkerRange(range: CodeCompletionRange): {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
} {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
  };
}

function fromMonacoRange(range: Monaco.IRange): CodeCompletionRange {
  return {
    start: {
      line: range.startLineNumber - 1,
      character: range.startColumn - 1
    },
    end: {
      line: range.endLineNumber - 1,
      character: range.endColumn - 1
    }
  };
}

function diagnosticFromMarker(marker: Monaco.editor.IMarkerData): CodeDiagnostic {
  return {
    range: {
      start: {
        line: marker.startLineNumber - 1,
        character: marker.startColumn - 1
      },
      end: {
        line: marker.endLineNumber - 1,
        character: marker.endColumn - 1
      }
    },
    severity: lspSeverity(marker.severity),
    code: typeof marker.code === "string" || typeof marker.code === "number"
      ? marker.code
      : undefined,
    source: marker.source,
    message: marker.message,
    tags: marker.tags
  };
}

function lspSeverity(severity: Monaco.MarkerSeverity): CodeDiagnostic["severity"] {
  if (severity === 8) {
    return 1;
  }

  if (severity === 4) {
    return 2;
  }

  if (severity === 2) {
    return 3;
  }

  return 4;
}

function toMonacoRange(monaco: MonacoApi, range: CodeCompletionRange): Monaco.Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1
  );
}

function markerSeverity(
  monaco: MonacoApi,
  severity: CodeDiagnostic["severity"]
): Monaco.MarkerSeverity {
  if (severity === 1) {
    return monaco.MarkerSeverity.Error;
  }

  if (severity === 2) {
    return monaco.MarkerSeverity.Warning;
  }

  if (severity === 3) {
    return monaco.MarkerSeverity.Info;
  }

  return monaco.MarkerSeverity.Hint;
}

function markerTags(monaco: MonacoApi, tags: number[] | undefined): Monaco.MarkerTag[] | undefined {
  if (!tags?.length) {
    return undefined;
  }

  return tags
    .map((tag) => {
      if (tag === 1) {
        return monaco.MarkerTag.Unnecessary;
      }

      if (tag === 2) {
        return monaco.MarkerTag.Deprecated;
      }

      return undefined;
    })
    .filter((tag): tag is Monaco.MarkerTag => tag !== undefined);
}

function lspPosition(position: Monaco.Position): { line: number; character: number } {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1
  };
}

function pathFromModelUri(uri: Monaco.Uri): string {
  return decodeURIComponent(uri.path.replace(/^\//, "")) || "untitled";
}

function modelUri(monaco: MonacoApi, path: string): Monaco.Uri {
  const normalized = (path || "untitled").replace(/\\/g, "/");
  return monaco.Uri.parse(`qoder://workspace/${encodeURIComponent(normalized)}`);
}
