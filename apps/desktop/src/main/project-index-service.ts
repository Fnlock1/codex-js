import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type {
  CodeFileEvent,
  ProjectIndexSearchRequest,
  ProjectIndexSummary,
  ProjectIndexSymbol
} from "@qoder-open/shared";
import type { WorkspaceService } from "./workspace-service.js";

interface IndexedFile {
  path: string;
  languageId: string;
  symbols: ProjectIndexSymbol[];
}

const indexableExtensions = new Set([
  "go",
  "js",
  "jsx",
  "py",
  "rs",
  "ts",
  "tsx",
  "vue"
]);

const projectFileNames = [
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "vite.config.ts",
  "vite.config.js"
];

export class ProjectIndexService {
  private indexedWorkspace = "";
  private indexedAt = 0;
  private files = new Map<string, IndexedFile>();
  private projectFiles: string[] = [];
  private rebuildPromise: Promise<ProjectIndexSummary> | undefined;

  constructor(private readonly workspaceService: WorkspaceService) {}

  async summary(): Promise<ProjectIndexSummary> {
    if (this.indexedWorkspace !== this.workspaceService.cwd || this.indexedAt === 0) {
      return this.rebuild();
    }

    return this.currentSummary();
  }

  async rebuild(): Promise<ProjectIndexSummary> {
    if (this.rebuildPromise) {
      return this.rebuildPromise;
    }

    this.rebuildPromise = this.rebuildNow().finally(() => {
      this.rebuildPromise = undefined;
    });

    return this.rebuildPromise;
  }

  async search(request: ProjectIndexSearchRequest): Promise<ProjectIndexSymbol[]> {
    await this.summary();
    const query = request.query.trim().toLowerCase();
    const limit = Math.max(1, Math.min(request.limit ?? 60, 200));
    const symbols = Array.from(this.files.values()).flatMap((file) => file.symbols);

    if (!query) {
      return symbols.slice(0, limit);
    }

    return symbols
      .map((symbol) => ({
        symbol,
        score: scoreSymbol(symbol.name, query)
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.symbol.name.localeCompare(b.symbol.name))
      .slice(0, limit)
      .map((entry) => entry.symbol);
  }

  async didChangeFiles(events: CodeFileEvent[]): Promise<void> {
    if (this.indexedWorkspace !== this.workspaceService.cwd) {
      this.reset();
      return;
    }

    for (const event of events) {
      if (event.type === "deleted") {
        this.files.delete(event.path);
        this.projectFiles = this.projectFiles.filter((path) => path !== event.path);
        continue;
      }

      if (projectFileNames.includes(basename(event.path))) {
        this.projectFiles = this.detectProjectFiles();
      }

      if (isIndexablePath(event.path)) {
        await this.indexFile(event.path);
      }
    }

    this.indexedAt = Date.now();
  }

  reset(): void {
    this.indexedWorkspace = "";
    this.indexedAt = 0;
    this.files.clear();
    this.projectFiles = [];
  }

  private async rebuildNow(): Promise<ProjectIndexSummary> {
    this.indexedWorkspace = this.workspaceService.cwd;
    this.indexedAt = Date.now();
    this.files.clear();
    this.projectFiles = this.detectProjectFiles();

    const snapshot = await this.workspaceService.snapshot();
    const indexableFiles = snapshot.files
      .filter((entry) => entry.kind === "file" && isIndexablePath(entry.path))
      .slice(0, 5000);

    for (const entry of indexableFiles) {
      await this.indexFile(entry.path);
    }

    this.indexedAt = Date.now();
    return this.currentSummary();
  }

  private async indexFile(path: string): Promise<void> {
    try {
      const result = await this.workspaceService.readFile(path);
      const languageId = languageIdForPath(path);
      this.files.set(path, {
        path,
        languageId,
        symbols: extractSymbols(path, languageId, result.content)
      });
    } catch {
      this.files.delete(path);
    }
  }

  private currentSummary(): ProjectIndexSummary {
    const languages: Record<string, number> = {};
    let symbolCount = 0;

    for (const file of this.files.values()) {
      languages[file.languageId] = (languages[file.languageId] ?? 0) + 1;
      symbolCount += file.symbols.length;
    }

    return {
      workspace: this.workspaceService.cwd,
      indexedAt: this.indexedAt,
      files: this.files.size,
      symbols: symbolCount,
      languages,
      projectFiles: this.projectFiles
    };
  }

  private detectProjectFiles(): string[] {
    return projectFileNames.filter((fileName) => existsSync(resolve(this.workspaceService.cwd, fileName)));
  }
}

function isIndexablePath(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return indexableExtensions.has(extension);
}

function languageIdForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    go: "go",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rs: "rust",
    ts: "typescript",
    tsx: "typescript",
    vue: "vue"
  };

  return map[extension] ?? "plaintext";
}

function extractSymbols(path: string, languageId: string, content: string): ProjectIndexSymbol[] {
  const symbols: ProjectIndexSymbol[] = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const patterns = patternsFor(languageId);

    for (const pattern of patterns) {
      const match = pattern.regex.exec(line);

      if (!match?.groups?.name) {
        continue;
      }

      symbols.push({
        name: match.groups.name,
        kind: pattern.kind,
        path,
        line: lineNumber,
        column: (match.index ?? 0) + 1,
        languageId
      });
      break;
    }
  });

  if (languageId === "vue") {
    const componentName = basename(path).replace(/\.vue$/i, "");
    symbols.unshift({
      name: componentName,
      kind: "component",
      path,
      line: 1,
      column: 1,
      languageId
    });
  }

  return symbols.slice(0, 1000);
}

function patternsFor(languageId: string): Array<{
  kind: ProjectIndexSymbol["kind"];
  regex: RegExp;
}> {
  if (languageId === "python") {
    return [
      { kind: "class", regex: /^\s*class\s+(?<name>[A-Za-z_][\w]*)/ },
      { kind: "function", regex: /^\s*def\s+(?<name>[A-Za-z_][\w]*)/ },
      { kind: "function", regex: /^\s*async\s+def\s+(?<name>[A-Za-z_][\w]*)/ },
      { kind: "variable", regex: /^\s*(?<name>[A-Za-z_][\w]*)\s*=/ }
    ];
  }

  if (languageId === "go") {
    return [
      { kind: "function", regex: /^\s*func(?:\s+\([^)]*\))?\s+(?<name>[A-Za-z_][\w]*)/ },
      { kind: "type", regex: /^\s*type\s+(?<name>[A-Za-z_][\w]*)\s+/ },
      { kind: "variable", regex: /^\s*(?:var|const)\s+(?<name>[A-Za-z_][\w]*)/ }
    ];
  }

  if (languageId === "rust") {
    return [
      { kind: "function", regex: /^\s*(?:pub\s+)?fn\s+(?<name>[A-Za-z_][\w]*)/ },
      { kind: "class", regex: /^\s*(?:pub\s+)?struct\s+(?<name>[A-Za-z_][\w]*)/ },
      { kind: "type", regex: /^\s*(?:pub\s+)?enum\s+(?<name>[A-Za-z_][\w]*)/ },
      { kind: "variable", regex: /^\s*let\s+(?:mut\s+)?(?<name>[A-Za-z_][\w]*)/ }
    ];
  }

  return [
    { kind: "class", regex: /^\s*export\s+default\s+class\s+(?<name>[A-Za-z_$][\w$]*)/ },
    { kind: "class", regex: /^\s*(?:export\s+)?class\s+(?<name>[A-Za-z_$][\w$]*)/ },
    { kind: "function", regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(?<name>[A-Za-z_$][\w$]*)/ },
    { kind: "function", regex: /^\s*(?:export\s+)?const\s+(?<name>[A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/ },
    { kind: "variable", regex: /^\s*(?:export\s+)?(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)/ },
    { kind: "interface", regex: /^\s*(?:export\s+)?interface\s+(?<name>[A-Za-z_$][\w$]*)/ },
    { kind: "type", regex: /^\s*(?:export\s+)?type\s+(?<name>[A-Za-z_$][\w$]*)/ }
  ];
}

function scoreSymbol(name: string, query: string): number {
  const lowerName = name.toLowerCase();

  if (lowerName === query) {
    return 100;
  }

  if (lowerName.startsWith(query)) {
    return 80;
  }

  if (lowerName.includes(query)) {
    return 50;
  }

  return fuzzyIncludes(lowerName, query) ? 20 : 0;
}

function fuzzyIncludes(value: string, query: string): boolean {
  let valueIndex = 0;

  for (const char of query) {
    valueIndex = value.indexOf(char, valueIndex);

    if (valueIndex < 0) {
      return false;
    }

    valueIndex += 1;
  }

  return true;
}
