export const APPLY_PATCH_MARKERS = Object.freeze({
  BEGIN: "*** Begin Patch",
  END: "*** End Patch",
  ENVIRONMENT_ID: "*** Environment ID: ",
  ADD_FILE: "*** Add File: ",
  DELETE_FILE: "*** Delete File: ",
  UPDATE_FILE: "*** Update File: ",
  MOVE_TO: "*** Move to: ",
  END_OF_FILE: "*** End of File"
});

export const APPLY_PATCH_HUNK_TYPES = Object.freeze({
  ADD_FILE: "add_file",
  DELETE_FILE: "delete_file",
  UPDATE_FILE: "update_file"
});

export class ApplyPatchParseError extends Error {
  constructor(message, lineNumber = null) {
    super(lineNumber == null ? message : `${message} at line ${lineNumber}`);
    this.name = "ApplyPatchParseError";
    this.lineNumber = lineNumber;
    this.code = "apply_patch_parse_error";
  }
}

export function createApplyPatchParseError(message, lineNumber = null) {
  return new ApplyPatchParseError(message, lineNumber);
}

export function parseApplyPatch(patchText) {
  const patch = normalizeApplyPatchText(patchText);
  const lines = patch.split(/\r?\n/);

  if (lines.length < 2 || lines[0].trim() !== APPLY_PATCH_MARKERS.BEGIN) {
    throw createApplyPatchParseError("invalid patch: missing begin marker", 1);
  }

  if (lines.at(-1)?.trim() !== APPLY_PATCH_MARKERS.END) {
    throw createApplyPatchParseError("invalid patch: missing end marker", lines.length);
  }

  let index = 1;
  let environmentId = null;

  if (lines[index]?.trimStart().startsWith(APPLY_PATCH_MARKERS.ENVIRONMENT_ID)) {
    environmentId = lines[index].trimStart().slice(APPLY_PATCH_MARKERS.ENVIRONMENT_ID.length).trim();

    if (!environmentId) {
      throw createApplyPatchParseError("environment id cannot be empty", index + 1);
    }

    index += 1;
  }

  const hunks = parseApplyPatchHunks(lines.slice(index, -1), index + 1);

  if (hunks.length === 0) {
    throw createApplyPatchParseError("invalid patch: expected at least one hunk", index + 1);
  }

  return {
    patch,
    environmentId,
    hunks,
    files: filesForHunks(hunks),
    summary: summarizeParsedHunks(hunks)
  };
}

export function normalizeApplyPatchText(patchText) {
  const text = String(patchText ?? "").trim();
  const lines = text.split(/\r?\n/);
  const first = lines[0]?.trim();
  const last = lines.at(-1)?.trim();

  if (
    ["<<EOF", "<<'EOF'", "<<\"EOF\""].includes(first) &&
    last === "EOF" &&
    lines.length >= 4
  ) {
    return normalizeApplyPatchText(lines.slice(1, -1).join("\n"));
  }

  return normalizeLenientCreateFilePatch(lines) ?? text;
}

function normalizeLenientCreateFilePatch(lines) {
  if (lines[0]?.trim() !== APPLY_PATCH_MARKERS.BEGIN) {
    return null;
  }

  const fileMarkerIndex = lines.findIndex((line, index) => (
    index > 0 &&
    lenientCreateFilePath(line) != null
  ));

  if (fileMarkerIndex < 0) {
    return null;
  }

  const path = lenientCreateFilePath(lines[fileMarkerIndex]);
  let contentStartIndex = fileMarkerIndex + 1;

  while (contentStartIndex < lines.length && lines[contentStartIndex]?.trim() === "") {
    contentStartIndex += 1;
  }

  if (lenientContentMarker(lines[contentStartIndex])) {
    contentStartIndex += 1;
  }

  const contentLines = [];

  for (let index = contentStartIndex; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === APPLY_PATCH_MARKERS.END || isLenientCreateFileTerminator(trimmed)) {
      break;
    }

    contentLines.push(line);
  }

  if (!path || contentLines.length === 0) {
    return null;
  }

  return [
    APPLY_PATCH_MARKERS.BEGIN,
    `${APPLY_PATCH_MARKERS.ADD_FILE}${path}`,
    ...contentLines.map((line) => `+${line}`),
    APPLY_PATCH_MARKERS.END
  ].join("\n");
}

function lenientCreateFilePath(line) {
  const match = String(line ?? "").trim().match(
    /^(?:create|add|new)\s+(?:a\s+)?(?:new\s+)?file\s*:\s*(.+)$/iu
  );

  if (!match) {
    return null;
  }

  return unquoteLenientPath(match[1].trim());
}

function unquoteLenientPath(path) {
  const text = String(path ?? "").trim();

  if (
    (text.startsWith("\"") && text.endsWith("\"")) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1).trim();
  }

  return text;
}

function lenientContentMarker(line) {
  return /^(?:replace\s+content|content)\s*:\s*$/iu.test(String(line ?? "").trim());
}

function isLenientCreateFileTerminator(trimmedLine) {
  return (
    trimmedLine === "EOF" ||
    trimmedLine === "ENDOFFILE" ||
    /^echo\s+/iu.test(trimmedLine)
  );
}

export function parseApplyPatchHunks(lines, startingLineNumber = 1) {
  const hunks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const lineNumber = startingLineNumber + index;
    const trimmed = line.trimStart();

    if (trimmed.startsWith(APPLY_PATCH_MARKERS.ADD_FILE)) {
      const path = trimmed.slice(APPLY_PATCH_MARKERS.ADD_FILE.length).trim();
      const addLines = [];
      index += 1;

      while (index < lines.length && isContentLine(lines[index])) {
        if (!lines[index].startsWith("+")) {
          throw createApplyPatchParseError("add file lines must start with +", startingLineNumber + index);
        }

        addLines.push(lines[index].slice(1));
        index += 1;
      }

      if (!path) {
        throw createApplyPatchParseError("add file path cannot be empty", lineNumber);
      }

      if (addLines.length === 0) {
        throw createApplyPatchParseError("add file hunk requires at least one line", lineNumber);
      }

      hunks.push({
        type: APPLY_PATCH_HUNK_TYPES.ADD_FILE,
        path,
        contents: addLines.join("\n")
      });
      continue;
    }

    if (trimmed.startsWith(APPLY_PATCH_MARKERS.DELETE_FILE)) {
      const path = trimmed.slice(APPLY_PATCH_MARKERS.DELETE_FILE.length).trim();

      if (!path) {
        throw createApplyPatchParseError("delete file path cannot be empty", lineNumber);
      }

      hunks.push({
        type: APPLY_PATCH_HUNK_TYPES.DELETE_FILE,
        path
      });
      index += 1;
      continue;
    }

    if (trimmed.startsWith(APPLY_PATCH_MARKERS.UPDATE_FILE)) {
      const path = trimmed.slice(APPLY_PATCH_MARKERS.UPDATE_FILE.length).trim();

      if (!path) {
        throw createApplyPatchParseError("update file path cannot be empty", lineNumber);
      }

      index += 1;
      let movePath = null;
      const chunks = [];

      if (lines[index]?.trimStart().startsWith(APPLY_PATCH_MARKERS.MOVE_TO)) {
        movePath = lines[index].trimStart().slice(APPLY_PATCH_MARKERS.MOVE_TO.length).trim();

        if (!movePath) {
          throw createApplyPatchParseError("move path cannot be empty", startingLineNumber + index);
        }

        index += 1;
      }

      while (index < lines.length && isUpdateChunkLine(lines[index])) {
        const chunkLineNumber = startingLineNumber + index;
        let changeContext = null;

        if (lines[index].trim() === "@@") {
          index += 1;
        } else if (lines[index].trimStart().startsWith("@@ ")) {
          changeContext = lines[index].trimStart().slice(3).trim();
          index += 1;
        }

        const oldLines = [];
        const newLines = [];
        let isEndOfFile = false;

        while (index < lines.length && isContentLine(lines[index])) {
          const changeLine = lines[index];

          if (changeLine.startsWith("-")) {
            oldLines.push(changeLine.slice(1));
          } else if (changeLine.startsWith("+")) {
            newLines.push(changeLine.slice(1));
          } else if (changeLine.startsWith(" ")) {
            const contextLine = changeLine.slice(1);
            oldLines.push(contextLine);
            newLines.push(contextLine);
          } else {
            break;
          }

          index += 1;
        }

        if (lines[index]?.trim() === APPLY_PATCH_MARKERS.END_OF_FILE) {
          isEndOfFile = true;
          index += 1;
        }

        chunks.push({
          changeContext,
          oldLines,
          newLines,
          isEndOfFile,
          lineNumber: chunkLineNumber
        });
      }

      if (chunks.length === 0) {
        throw createApplyPatchParseError(`update file hunk for path '${path}' is empty`, lineNumber);
      }

      hunks.push({
        type: APPLY_PATCH_HUNK_TYPES.UPDATE_FILE,
        path,
        movePath,
        chunks
      });
      continue;
    }

    throw createApplyPatchParseError("invalid hunk marker", lineNumber);
  }

  return hunks;
}

function isUpdateChunkLine(line) {
  if (line == null) {
    return false;
  }

  const trimmed = line.trimStart();
  return (
    trimmed === "@@" ||
    trimmed.startsWith("@@ ") ||
    isContentLine(line) ||
    trimmed === APPLY_PATCH_MARKERS.END_OF_FILE
  );
}

function isContentLine(line) {
  return typeof line === "string" && (
    line.startsWith("+") ||
    line.startsWith("-") ||
    line.startsWith(" ")
  );
}

function filesForHunks(hunks) {
  return Array.from(new Set(hunks.flatMap((hunk) => (
    hunk.movePath ? [hunk.path, hunk.movePath] : [hunk.path]
  ))));
}

function summarizeParsedHunks(hunks) {
  const summary = {
    add: 0,
    delete: 0,
    update: 0,
    move: 0,
    files: filesForHunks(hunks)
  };

  for (const hunk of hunks) {
    if (hunk.type === APPLY_PATCH_HUNK_TYPES.ADD_FILE) {
      summary.add += 1;
    } else if (hunk.type === APPLY_PATCH_HUNK_TYPES.DELETE_FILE) {
      summary.delete += 1;
    } else if (hunk.type === APPLY_PATCH_HUNK_TYPES.UPDATE_FILE) {
      summary.update += 1;

      if (hunk.movePath) {
        summary.move += 1;
      }
    }
  }

  return summary;
}
