<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as monaco from "monaco-editor";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import {
  javascriptDefaults,
  JsxEmit,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  typescriptDefaults
} from "monaco-editor/esm/vs/language/typescript/monaco.contribution";
import { registerLanguageCompletions } from "../editor/completion";
import { expandHtmlAbbreviation, registerEmmet } from "../editor/emmet";
import { registerLanguageFeatures, syncLanguageModel } from "../editor/language-features";
import { ensureLanguage } from "../editor/language-registry";
import { registerBuiltInLanguages } from "../editor/languages";

const props = defineProps<{
  path: string;
  content: string;
  readOnly: boolean;
}>();

const emit = defineEmits<{
  "update-content": [content: string];
  "save-file": [];
}>();

const editorHost = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let model: monaco.editor.ITextModel | undefined;
let resizeObserver: ResizeObserver | undefined;
let syncingFromProps = false;

setupMonacoEnvironment();
configureLanguageDefaults();
defineQoderTheme();
registerBuiltInLanguages();
registerEmmet(monaco);
registerLanguageCompletions(monaco);
registerLanguageFeatures(monaco);

onMounted(async () => {
  await nextTick();
  await createEditor();
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  editor?.dispose();
  editor = undefined;
  model = undefined;
  resizeObserver = undefined;
});

watch(
  () => [props.path, props.content] as const,
  async ([path, content], [previousPath]) => {
    if (!editor) {
      return;
    }

    if (path !== previousPath) {
      await attachModel(path, content);
      return;
    }

    if (model && content !== model.getValue()) {
      syncingFromProps = true;
      model.setValue(content);
      syncingFromProps = false;
      syncLanguageModel(model, 0);
    }
  }
);

watch(
  () => props.readOnly,
  (readOnly) => {
    editor?.updateOptions({ readOnly });
  }
);

async function createEditor(): Promise<void> {
  if (!editorHost.value) {
    return;
  }

  model = await getModel(props.path, props.content);
  editor = monaco.editor.create(editorHost.value, {
    model,
    theme: "qoder-dark",
    readOnly: props.readOnly,
    automaticLayout: false,
    cursorBlinking: "blink",
    cursorSmoothCaretAnimation: "on",
    definitionLinkOpensInPeek: false,
    fontFamily: 'Consolas, "Cascadia Code", "Courier New", monospace',
    fontLigatures: false,
    fontSize: 15,
    lineHeight: 24,
    links: true,
    minimap: {
      enabled: true,
      scale: 1,
      showSlider: "mouseover"
    },
    padding: {
      top: 12,
      bottom: 22
    },
    renderLineHighlight: "all",
    roundedSelection: false,
    scrollBeyondLastLine: false,
    "semanticHighlighting.enabled": true,
    scrollbar: {
      verticalScrollbarSize: 12,
      horizontalScrollbarSize: 12
    },
    smoothScrolling: true,
    tabSize: 2,
    wordWrap: "off"
  });

  const tabCommandId = editor.addCommand(0, () => {
    editor?.trigger("keyboard", "tab", null);
  });

  editor.onDidChangeModelContent(() => {
    if (!model || syncingFromProps) {
      return;
    }

    emit("update-content", model.getValue());
    syncLanguageModel(model);
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    emit("save-file");
  });
  editor.addCommand(monaco.KeyCode.Tab, () => {
    if (!editor || !model || tryExpandEmmet(model)) {
      return;
    }

    if (tabCommandId) {
      editor.trigger("keyboard", tabCommandId, null);
    }
  });
  resizeObserver = new ResizeObserver(() => {
    editor?.layout();
  });
  resizeObserver.observe(editorHost.value);
  editor.focus();
}

async function attachModel(path: string, content: string): Promise<void> {
  model = await getModel(path, content);
  editor?.setModel(model);
  syncLanguageModel(model, 0);
  editor?.focus();
}

async function getModel(path: string, content: string): Promise<monaco.editor.ITextModel> {
  const languageId = await ensureLanguage(monaco, path);
  const uri = modelUri(path);
  const existingModel = monaco.editor.getModel(uri);

  if (existingModel) {
    monaco.editor.setModelLanguage(existingModel, languageId);

    if (existingModel.getValue() !== content) {
      syncingFromProps = true;
      existingModel.setValue(content);
      syncingFromProps = false;
    }

    syncLanguageModel(existingModel, 0);
    return existingModel;
  }

  const nextModel = monaco.editor.createModel(content, languageId, uri);
  syncLanguageModel(nextModel, 0);
  return nextModel;
}

function modelUri(path: string): monaco.Uri {
  const normalized = (path || "untitled").replace(/\\/g, "/");
  return monaco.Uri.parse(`qoder://workspace/${encodeURIComponent(normalized)}`);
}

function tryExpandEmmet(model: monaco.editor.ITextModel): boolean {
  if (!editor || !isEmmetMarkupContext(model)) {
    return false;
  }

  const position = editor.getPosition();

  if (!position) {
    return false;
  }

  const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
  const match = /([A-Za-z][\w-]*|[.#][\w-]+)(?:[.#>+*${}\[\]\w\-:@()=]+)?$/.exec(linePrefix);
  const abbreviation = match?.[0];

  if (!abbreviation) {
    return false;
  }

  const expanded = expandHtmlAbbreviation(abbreviation);

  if (!expanded || expanded === abbreviation) {
    return false;
  }

  const startColumn = position.column - abbreviation.length;
  const range = new monaco.Range(position.lineNumber, startColumn, position.lineNumber, position.column);
  editor.executeEdits("emmet", [
    {
      range,
      text: expanded,
      forceMoveMarkers: true
    }
  ]);
  return true;
}

function isEmmetMarkupContext(model: monaco.editor.ITextModel): boolean {
  const languageId = model.getLanguageId();

  if (languageId === "html") {
    return true;
  }

  if (languageId !== "vue" || !editor) {
    return false;
  }

  const position = editor.getPosition();

  if (!position) {
    return false;
  }

  const before = model.getValueInRange({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column
  });
  const open = before.lastIndexOf("<template");
  const close = before.lastIndexOf("</template>");

  return open >= 0 && open > close;
}

function setupMonacoEnvironment(): void {
  const globalScope = globalThis as typeof globalThis & {
    MonacoEnvironment?: {
      getWorker: (_workerId: string, label: string) => Worker;
    };
  };

  if (globalScope.MonacoEnvironment) {
    return;
  }

  globalScope.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      if (label === "json") {
        return new JsonWorker();
      }

      if (label === "css" || label === "scss" || label === "less") {
        return new CssWorker();
      }

      if (label === "html" || label === "handlebars" || label === "razor") {
        return new HtmlWorker();
      }

      if (label === "typescript" || label === "javascript") {
        return new TsWorker();
      }

      return new EditorWorker();
    }
  };
}

function configureLanguageDefaults(): void {
  const compilerOptions = {
    allowJs: true,
    allowSyntheticDefaultImports: true,
    checkJs: false,
    jsx: JsxEmit.Preserve,
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.NodeJs,
    noEmit: true,
    target: ScriptTarget.ESNext,
    typeRoots: ["node_modules/@types"]
  };
  const diagnosticsOptions = {
    noSemanticValidation: false,
    noSyntaxValidation: false
  };

  typescriptDefaults.setCompilerOptions(compilerOptions);
  typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
  typescriptDefaults.setEagerModelSync(true);
  javascriptDefaults.setCompilerOptions(compilerOptions);
  javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
  javascriptDefaults.setEagerModelSync(true);
}

function defineQoderTheme(): void {
  monaco.editor.defineTheme("qoder-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6a9955" },
      { token: "keyword", foreground: "4fc3ff" },
      { token: "number", foreground: "b5cea8" },
      { token: "string", foreground: "d7ba7d" },
      { token: "tag", foreground: "4fc3ff" },
      { token: "tag.vue", foreground: "4fc3ff", fontStyle: "bold" },
      { token: "attribute.name", foreground: "9cdcfe" },
      { token: "attribute.name.vue", foreground: "9cdcfe" },
      { token: "attribute.event", foreground: "f0b36a" },
      { token: "attribute.event.vue", foreground: "f0b36a" },
      { token: "attribute.value", foreground: "d7ba7d" },
      { token: "attribute.value.vue", foreground: "d7ba7d" },
      { token: "delimiter", foreground: "d4d4d4" },
      { token: "delimiter.angle", foreground: "d4d4d4" },
      { token: "delimiter.angle.vue", foreground: "d4d4d4" },
      { token: "delimiter.event", foreground: "f0b36a" },
      { token: "delimiter.event.vue", foreground: "f0b36a" },
      { token: "delimiter.bracket", foreground: "ffd700" },
      { token: "class", foreground: "4ec9b0" },
      { token: "enum", foreground: "4ec9b0" },
      { token: "interface", foreground: "4ec9b0" },
      { token: "type", foreground: "4ec9b0" },
      { token: "typeParameter", foreground: "4ec9b0" },
      { token: "variable", foreground: "9cdcfe" },
      { token: "parameter", foreground: "c8d78f" },
      { token: "property", foreground: "9cdcfe" },
      { token: "function", foreground: "dcdcaa" },
      { token: "method", foreground: "dcdcaa" },
      { token: "component", foreground: "7ee787", fontStyle: "bold" },
      { token: "variable.readonly", foreground: "b5cea8" },
      { token: "property.readonly", foreground: "b5cea8" },
      { token: "function.async", foreground: "dcdcaa", fontStyle: "italic" },
      { token: "method.async", foreground: "dcdcaa", fontStyle: "italic" }
    ],
    colors: {
      "editor.background": "#1c1e1b",
      "editor.foreground": "#dce4dc",
      "editor.lineHighlightBackground": "#242823",
      "editorLineNumber.foreground": "#858b85",
      "editorLineNumber.activeForeground": "#dce4dc",
      "editorCursor.foreground": "#d8ddd8",
      "editor.selectionBackground": "#31513a",
      "editor.inactiveSelectionBackground": "#26392c",
      "editorIndentGuide.background1": "#2b2f2a",
      "editorIndentGuide.activeBackground1": "#465046",
      "editorGutter.background": "#1c1e1b",
      "editorWidget.background": "#20231f",
      "editorWidget.border": "#363b34",
      "scrollbarSlider.background": "#444b4480",
      "scrollbarSlider.hoverBackground": "#59615990",
      "scrollbarSlider.activeBackground": "#6b746bb0"
    }
  });
}
</script>

<template>
  <div ref="editorHost" class="monaco-editor-host" />
  
</template>
