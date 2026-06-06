import { emmetCSS, emmetHTML, emmetJSX, expandAbbreviation } from "emmet-monaco-es";
import type { MonacoApi } from "./language-types";

let registered = false;

export function registerEmmet(monaco: MonacoApi): void {
  if (registered) {
    return;
  }

  registered = true;
  emmetHTML(monaco, ["html", "vue"], { tokenizer: "standard" });
  emmetCSS(monaco, ["css", "scss", "less"], { tokenizer: "standard" });
  emmetJSX(monaco, ["javascript", "typescript"], { tokenizer: "standard" });
}

export function expandHtmlAbbreviation(abbreviation: string): string | undefined {
  const value = abbreviation.trim();

  if (!isLikelyHtmlAbbreviation(value)) {
    return undefined;
  }

  try {
    return expandAbbreviation(value, {
      type: "markup",
      syntax: "html",
      options: {
        "output.selfClosingStyle": "html"
      }
    });
  } catch {
    return undefined;
  }
}

function isLikelyHtmlAbbreviation(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 120 &&
    !/\s/.test(value) &&
    /[.#>[*+$@{}[\]():-]/.test(value)
  );
}
