import { registerLanguage } from "./language-registry";
import type { LanguageContribution, MonacoApi } from "./language-types";

let registered = false;

export function registerBuiltInLanguages(): void {
  if (registered) {
    return;
  }

  registered = true;

  [
    javascriptLanguage,
    typescriptLanguage,
    jsonLanguage,
    cssLanguage,
    htmlLanguage,
    markdownLanguage,
    vueLanguage,
    pythonLanguage,
    rustLanguage,
    goLanguage,
    powershellLanguage,
    shellLanguage,
    yamlLanguage
  ].forEach(registerLanguage);
}

async function setupJavascript(): Promise<void> {
  await import("monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js");
}

async function setupTypescript(): Promise<void> {
  await import("monaco-editor/esm/vs/language/typescript/monaco.contribution.js");
}

async function setupJson(): Promise<void> {
  await import("monaco-editor/esm/vs/language/json/monaco.contribution.js");
}

async function setupCss(): Promise<void> {
  await import("monaco-editor/esm/vs/language/css/monaco.contribution.js");
}

async function setupHtml(): Promise<void> {
  await import("monaco-editor/esm/vs/language/html/monaco.contribution.js");
}

async function setupMarkdown(): Promise<void> {
  await import("monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js");
}

async function setupRust(): Promise<void> {
  await import("monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js");
}

async function setupGo(): Promise<void> {
  await import("monaco-editor/esm/vs/basic-languages/go/go.contribution.js");
}

function registerMonarchLanguage(
  monaco: MonacoApi,
  contribution: Omit<LanguageContribution, "setup">,
  language: Parameters<typeof monaco.languages.setMonarchTokensProvider>[1]
): void {
  if (!monaco.languages.getLanguages().some((item) => item.id === contribution.id)) {
    monaco.languages.register({
      id: contribution.id,
      extensions: contribution.extensions,
      filenames: contribution.filenames,
      aliases: contribution.aliases
    });
  }

  monaco.languages.setMonarchTokensProvider(contribution.id, language);
}

const javascriptLanguage: LanguageContribution = {
  id: "javascript",
  label: "JavaScript",
  extensions: [".js", ".jsx", ".mjs", ".cjs"],
  aliases: ["JavaScript", "javascript", "js"],
  setup: setupJavascript
};

const typescriptLanguage: LanguageContribution = {
  id: "typescript",
  label: "TypeScript",
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  aliases: ["TypeScript", "typescript", "ts"],
  setup: setupTypescript
};

const jsonLanguage: LanguageContribution = {
  id: "json",
  label: "JSON",
  extensions: [".json", ".jsonc"],
  aliases: ["JSON", "json"],
  setup: setupJson
};

const cssLanguage: LanguageContribution = {
  id: "css",
  label: "CSS",
  extensions: [".css", ".scss", ".sass", ".less"],
  aliases: ["CSS", "css"],
  setup: setupCss
};

const htmlLanguage: LanguageContribution = {
  id: "html",
  label: "HTML",
  extensions: [".html", ".htm", ".svg", ".xml"],
  aliases: ["HTML", "html"],
  setup: setupHtml
};

const markdownLanguage: LanguageContribution = {
  id: "markdown",
  label: "Markdown",
  extensions: [".md", ".markdown", ".mdx"],
  aliases: ["Markdown", "markdown", "md"],
  setup: setupMarkdown
};

const vueLanguage: LanguageContribution = {
  id: "vue",
  label: "Vue",
  extensions: [".vue"],
  aliases: ["Vue", "vue"],
  async setup(monaco) {
    await Promise.all([setupHtml(), setupTypescript(), setupCss()]);
    registerMonarchLanguage(monaco, vueLanguage, {
      defaultToken: "",
      tokenPostfix: ".vue",
      tokenizer: {
        root: [
          [/<!--/, "comment", "@comment"],
          [/(<\/?)(template)(\b)/, ["delimiter.angle", "tag.vue", { token: "", next: "@templateOpen" }]],
          [/(<\/?)(script)(\b)/, ["delimiter.angle", "tag.vue", { token: "", next: "@scriptOpen" }]],
          [/(<\/?)(style)(\b)/, ["delimiter.angle", "tag.vue", { token: "", next: "@styleOpen" }]],
          [/(<\/?)([a-zA-Z][\w-]*)(\b)/, ["delimiter.angle", "tag", { token: "", next: "@tag" }]],
          [/[^<]+/, ""],
          [/</, "delimiter.angle"]
        ],
        tag: [
          [/\s+/, ""],
          [/[a-zA-Z_:][\w:.-]*/, "attribute.name"],
          [/=/, "delimiter"],
          [/"/, "attribute.value", "@attributeDouble"],
          [/'/, "attribute.value", "@attributeSingle"],
          [/\/?>/, { token: "delimiter.angle", next: "@pop" }]
        ],
        attributeDouble: [
          [/[^"]+/, "string"],
          [/"/, "attribute.value", "@pop"]
        ],
        attributeSingle: [
          [/[^']+/, "string"],
          [/'/, "attribute.value", "@pop"]
        ],
        templateOpen: [
          [/\s+/, ""],
          [/[a-zA-Z_:][\w:.-]*/, "attribute.name"],
          [/=/, "delimiter"],
          [/"/, "attribute.value", "@attributeDouble"],
          [/'/, "attribute.value", "@attributeSingle"],
          [/>/, { token: "delimiter.angle", next: "@template" }],
          [/\/>/, { token: "delimiter.angle", next: "@pop" }]
        ],
        template: [
          [/<!--/, "comment", "@comment"],
          [/<\/template\s*>/, { token: "@rematch", next: "@pop" }],
          [/(<\/?)([A-Z][\w.]*)(\b)/, ["delimiter.angle", "component", { token: "", next: "@templateTag" }]],
          [/(<\/?)([a-zA-Z][\w-]*)(\b)/, ["delimiter.angle", "tag", { token: "", next: "@templateTag" }]],
          [/{{/, { token: "delimiter.bracket", next: "@mustache" }],
          [/[^<{]+/, ""],
          [/</, "delimiter.angle"],
          [/[{}()[\]]/, "@brackets"]
        ],
        templateTag: [
          [/\s+/, ""],
          [/v-(?:if|else-if|else|for|show|model|bind|on|slot|html|text|memo|once|pre|cloak)(?:\.[\w-]+)*/, "keyword"],
          [/v-[a-zA-Z_][\w:.-]*/, "keyword"],
          [/:[a-zA-Z_][\w:.-]*/, "attribute.name"],
          [/(@)([a-zA-Z_][\w:.-]*)/, ["delimiter.event", "attribute.name"]],
          [/#\w[\w.-]*/, "attribute.name"],
          [/[a-zA-Z_:][\w:.-]*/, "attribute.name"],
          [/=/, "delimiter"],
          [/"/, "attribute.value", "@templateAttrDouble"],
          [/'/, "attribute.value", "@templateAttrSingle"],
          [/\/?>/, { token: "delimiter.angle", next: "@pop" }]
        ],
        templateAttrDouble: [
          [/[^"{]+/, "string"],
          [/{{/, { token: "delimiter.bracket", next: "@mustacheInDouble" }],
          [/"/, "attribute.value", "@pop"]
        ],
        templateAttrSingle: [
          [/[^'{]+/, "string"],
          [/{{/, { token: "delimiter.bracket", next: "@mustacheInSingle" }],
          [/'/, "attribute.value", "@pop"]
        ],
        mustache: [
          [/}}/, { token: "delimiter.bracket", next: "@pop" }],
          [/[^}]+/, "variable"]
        ],
        mustacheInDouble: [
          [/}}/, { token: "delimiter.bracket", next: "@pop" }],
          [/[^}]+/, "variable"]
        ],
        mustacheInSingle: [
          [/}}/, { token: "delimiter.bracket", next: "@pop" }],
          [/[^}]+/, "variable"]
        ],
        scriptOpen: [
          [/\s+/, ""],
          [/[a-zA-Z_:][\w:.-]*/, "attribute.name"],
          [/=/, "delimiter"],
          [/"/, "attribute.value", "@attributeDouble"],
          [/'/, "attribute.value", "@attributeSingle"],
          [/>/, { token: "delimiter.angle", next: "@script", nextEmbedded: "typescript" }],
          [/\/>/, { token: "delimiter.angle", next: "@pop" }]
        ],
        script: [
          [/<\/script\s*>/, { token: "@rematch", next: "@pop", nextEmbedded: "@pop" }]
        ],
        styleOpen: [
          [/\s+/, ""],
          [/[a-zA-Z_:][\w:.-]*/, "attribute.name"],
          [/=/, "delimiter"],
          [/"/, "attribute.value", "@attributeDouble"],
          [/'/, "attribute.value", "@attributeSingle"],
          [/>/, { token: "delimiter.angle", next: "@style", nextEmbedded: "css" }],
          [/\/>/, { token: "delimiter.angle", next: "@pop" }]
        ],
        style: [
          [/<\/style\s*>/, { token: "@rematch", next: "@pop", nextEmbedded: "@pop" }]
        ],
        comment: [
          [/[^-]+/, "comment"],
          [/-->/, "comment", "@pop"],
          [/[-]/, "comment"]
        ]
      }
    });
  }
};

const pythonLanguage: LanguageContribution = {
  id: "python",
  label: "Python",
  extensions: [".py", ".pyw"],
  aliases: ["Python", "python", "py"],
  setup(monaco) {
    registerMonarchLanguage(monaco, pythonLanguage, {
      defaultToken: "",
      keywords: [
        "and",
        "as",
        "assert",
        "async",
        "await",
        "break",
        "class",
        "continue",
        "def",
        "del",
        "elif",
        "else",
        "except",
        "False",
        "finally",
        "for",
        "from",
        "global",
        "if",
        "import",
        "in",
        "is",
        "lambda",
        "None",
        "nonlocal",
        "not",
        "or",
        "pass",
        "raise",
        "return",
        "True",
        "try",
        "while",
        "with",
        "yield"
      ],
      tokenizer: {
        root: [
          [/[a-zA-Z_]\w*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
          [/#.*$/, "comment"],
          [/("""|''')/, "string", "@tripleString.$1"],
          [/".*?"/, "string"],
          [/'.*?'/, "string"],
          [/\d+(\.\d+)?/, "number"],
          [/[{}()[\]]/, "@brackets"]
        ],
        tripleString: [
          [/[^"']+/, "string"],
          [/("""|''')/, { cases: { "$1==$S2": { token: "string", next: "@pop" }, "@default": "string" } }],
          [/["']/, "string"]
        ]
      }
    });
  }
};

const rustLanguage: LanguageContribution = {
  id: "rust",
  label: "Rust",
  extensions: [".rs"],
  aliases: ["Rust", "rust", "rs"],
  setup: setupRust
};

const goLanguage: LanguageContribution = {
  id: "go",
  label: "Go",
  extensions: [".go"],
  aliases: ["Go", "go", "golang"],
  setup: setupGo
};

const powershellLanguage: LanguageContribution = {
  id: "powershell",
  label: "PowerShell",
  extensions: [".ps1", ".psm1", ".psd1"],
  aliases: ["PowerShell", "powershell", "ps1"],
  setup(monaco) {
    registerMonarchLanguage(monaco, powershellLanguage, {
      defaultToken: "",
      keywords: [
        "begin",
        "break",
        "catch",
        "class",
        "continue",
        "data",
        "do",
        "dynamicparam",
        "else",
        "elseif",
        "end",
        "exit",
        "filter",
        "finally",
        "for",
        "foreach",
        "from",
        "function",
        "if",
        "in",
        "param",
        "process",
        "return",
        "switch",
        "throw",
        "trap",
        "try",
        "until",
        "using",
        "while"
      ],
      tokenizer: {
        root: [
          [/\$[a-zA-Z_][\w:]*/, "variable"],
          [/[a-zA-Z_][\w-]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
          [/#.*$/, "comment"],
          [/".*?"/, "string"],
          [/'.*?'/, "string"],
          [/\d+(\.\d+)?/, "number"],
          [/[{}()[\]]/, "@brackets"]
        ]
      }
    });
  }
};

const shellLanguage: LanguageContribution = {
  id: "shell",
  label: "Shell",
  extensions: [".sh", ".bash", ".zsh"],
  filenames: [".bashrc", ".zshrc", ".profile"],
  aliases: ["Shell", "shell", "bash"],
  setup(monaco) {
    registerMonarchLanguage(monaco, shellLanguage, {
      defaultToken: "",
      keywords: [
        "case",
        "do",
        "done",
        "elif",
        "else",
        "esac",
        "fi",
        "for",
        "function",
        "if",
        "in",
        "select",
        "then",
        "until",
        "while"
      ],
      tokenizer: {
        root: [
          [/\$[a-zA-Z_]\w*/, "variable"],
          [/[a-zA-Z_]\w*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
          [/#.*$/, "comment"],
          [/".*?"/, "string"],
          [/'.*?'/, "string"],
          [/\d+/, "number"],
          [/[{}()[\]]/, "@brackets"]
        ]
      }
    });
  }
};

const yamlLanguage: LanguageContribution = {
  id: "yaml",
  label: "YAML",
  extensions: [".yaml", ".yml"],
  aliases: ["YAML", "yaml", "yml"],
  setup(monaco) {
    registerMonarchLanguage(monaco, yamlLanguage, {
      defaultToken: "",
      tokenizer: {
        root: [
          [/^\s*#.*/, "comment"],
          [/^\s*[\w.-]+(?=\s*:)/, "attribute.name"],
          [/:/, "delimiter"],
          [/"[^"]*"/, "string"],
          [/'[^']*'/, "string"],
          [/\b(true|false|null)\b/, "keyword"],
          [/\d+(\.\d+)?/, "number"],
          [/[{}()[\]]/, "@brackets"]
        ]
      }
    });
  }
};
