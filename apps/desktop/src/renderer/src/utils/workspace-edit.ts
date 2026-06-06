import type { CodeCompletionRange, CodeCompletionTextEdit, CodeWorkspaceEdit } from "@qoder-open/shared";

export interface WorkspaceEditPathGroup {
  path: string;
  edits: CodeCompletionTextEdit[];
}

export function collectWorkspaceEditGroups(edit: CodeWorkspaceEdit): {
  groups: WorkspaceEditPathGroup[];
  skippedUris: string[];
} {
  const byPath = new Map<string, CodeCompletionTextEdit[]>();
  const skippedUris: string[] = [];

  for (const [path, edits] of Object.entries(edit.changes ?? {})) {
    appendEdits(byPath, normalizeWorkspacePath(path), edits);
  }

  for (const documentChange of edit.documentChanges ?? []) {
    if (!documentChange.path) {
      if (documentChange.uri) {
        skippedUris.push(documentChange.uri);
      }

      continue;
    }

    appendEdits(byPath, normalizeWorkspacePath(documentChange.path), documentChange.edits);
  }

  return {
    groups: Array.from(byPath.entries()).map(([path, edits]) => ({ path, edits })),
    skippedUris
  };
}

export function applyTextEdits(content: string, edits: CodeCompletionTextEdit[]): string {
  if (edits.length === 0) {
    return content;
  }

  const lineStarts = getLineStartOffsets(content);
  const normalizedEdits = edits.map((edit) => {
    const range = editRange(edit);
    const start = offsetAt(content, lineStarts, range.start.line, range.start.character);
    const end = offsetAt(content, lineStarts, range.end.line, range.end.character);

    if (start > end) {
      throw new Error("Invalid text edit range: start is after end.");
    }

    return {
      start,
      end,
      newText: edit.newText
    };
  });

  normalizedEdits.sort((left, right) => {
    if (left.start !== right.start) {
      return right.start - left.start;
    }

    return right.end - left.end;
  });

  let nextContent = content;
  let previousStart = Number.POSITIVE_INFINITY;

  for (const edit of normalizedEdits) {
    if (edit.end > previousStart) {
      throw new Error("Overlapping text edits are not supported.");
    }

    nextContent = `${nextContent.slice(0, edit.start)}${edit.newText}${nextContent.slice(edit.end)}`;
    previousStart = edit.start;
  }

  return nextContent;
}

function appendEdits(
  byPath: Map<string, CodeCompletionTextEdit[]>,
  path: string,
  edits: CodeCompletionTextEdit[]
): void {
  if (!path || edits.length === 0) {
    return;
  }

  byPath.set(path, [...(byPath.get(path) ?? []), ...edits]);
}

function editRange(edit: CodeCompletionTextEdit): CodeCompletionRange {
  return edit.range ?? edit.replace ?? edit.insert ?? {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 }
  };
}

function getLineStartOffsets(content: string): number[] {
  const starts = [0];

  for (let index = 0; index < content.length; index += 1) {
    const char = content.charCodeAt(index);

    if (char === 13) {
      if (content.charCodeAt(index + 1) === 10) {
        index += 1;
      }

      starts.push(index + 1);
      continue;
    }

    if (char === 10) {
      starts.push(index + 1);
    }
  }

  return starts;
}

function offsetAt(content: string, lineStarts: number[], line: number, character: number): number {
  const safeLine = Math.max(0, Math.min(line, lineStarts.length - 1));
  const lineStart = lineStarts[safeLine] ?? 0;
  const nextLineStart = lineStarts[safeLine + 1] ?? content.length;
  const lineEnd = trimLineEndingOffset(content, lineStart, nextLineStart);
  return Math.max(lineStart, Math.min(lineStart + Math.max(0, character), lineEnd));
}

function trimLineEndingOffset(content: string, lineStart: number, nextLineStart: number): number {
  let lineEnd = nextLineStart;

  if (lineEnd > lineStart && content.charCodeAt(lineEnd - 1) === 10) {
    lineEnd -= 1;
  }

  if (lineEnd > lineStart && content.charCodeAt(lineEnd - 1) === 13) {
    lineEnd -= 1;
  }

  return lineEnd;
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}
