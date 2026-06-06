import type * as Monaco from "monaco-editor";

export type MonacoApi = typeof Monaco;

export interface LanguageContribution {
  id: string;
  label: string;
  extensions: string[];
  filenames?: string[];
  aliases?: string[];
  setup: (monaco: MonacoApi) => Promise<void> | void;
}
