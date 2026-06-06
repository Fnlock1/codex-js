declare module "monaco-editor/esm/vs/language/typescript/monaco.contribution" {
  export interface TypeScriptCompilerOptions {
    [key: string]: unknown;
  }

  export interface TypeScriptDiagnosticsOptions {
    noSemanticValidation?: boolean;
    noSyntaxValidation?: boolean;
    onlyVisible?: boolean;
  }

  export interface TypeScriptLanguageServiceDefaults {
    setCompilerOptions(options: TypeScriptCompilerOptions): void;
    setDiagnosticsOptions(options: TypeScriptDiagnosticsOptions): void;
    setEagerModelSync(value: boolean): void;
  }

  export const JsxEmit: {
    Preserve: number;
    ReactJSX: number;
  };
  export const ModuleKind: {
    ESNext: number;
  };
  export const ModuleResolutionKind: {
    NodeJs: number;
  };
  export const ScriptTarget: {
    ESNext: number;
  };
  export const javascriptDefaults: TypeScriptLanguageServiceDefaults;
  export const typescriptDefaults: TypeScriptLanguageServiceDefaults;
}
