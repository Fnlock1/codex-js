import path from "node:path";
import {
  SANDBOX_ACCESS_TYPES,
  assertSandboxAllowed
} from "../sandbox/policy.js";
import { APPLY_PATCH_HUNK_TYPES } from "./parser.js";

export const APPLY_PATCH_CHANGE_TYPES = Object.freeze({
  ADD: "add",
  DELETE: "delete",
  UPDATE: "update"
});

export class ApplyPatchApplicationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApplyPatchApplicationError";
    this.code = options.code ?? "apply_patch_application_error";
    this.path = options.path ?? null;
  }
}

export function createApplyPatchApplicationError(message, options = {}) {
  return new ApplyPatchApplicationError(message, options);
}

export async function computeApplyPatchPlan(parsed, options = {}) {
  const workingDirectory = normalizeWorkingDirectory(options.workingDirectory);
  const fileProvider = options.fileProvider ?? {};
  const allowAbsolutePaths = options.allowAbsolutePaths ?? false;
  const sandboxPolicy = options.sandboxPolicy ?? null;
  const changes = [];
  const affected = {
    added: [],
    modified: [],
    deleted: []
  };

  for (const hunk of parsed.hunks) {
    const sourcePath = resolvePatchPath(hunk.path, {
      workingDirectory,
      allowAbsolutePaths
    });

    if (hunk.type === APPLY_PATCH_HUNK_TYPES.ADD_FILE) {
      const existing = await readPatchFile(fileProvider, sourcePath, hunk.path);

      if (existing.isDirectory) {
        throw createApplyPatchApplicationError(`cannot add file over directory: ${hunk.path}`, {
          code: "path_is_directory",
          path: hunk.path
        });
      }

      changes.push({
        type: APPLY_PATCH_CHANGE_TYPES.ADD,
        path: hunk.path,
        absolutePath: sourcePath.absolutePath,
        content: hunk.contents,
        overwrittenContent: existing.exists ? existing.content : null,
        existsBefore: existing.exists
      });
      assertSandboxWriteAllowed(sandboxPolicy, sourcePath.absolutePath);
      affected.added.push(hunk.path);
      continue;
    }

    if (hunk.type === APPLY_PATCH_HUNK_TYPES.DELETE_FILE) {
      const existing = await readRequiredPatchFile(fileProvider, sourcePath, hunk.path, "delete");

      changes.push({
        type: APPLY_PATCH_CHANGE_TYPES.DELETE,
        path: hunk.path,
        absolutePath: sourcePath.absolutePath,
        content: existing.content
      });
      assertSandboxWriteAllowed(sandboxPolicy, sourcePath.absolutePath);
      affected.deleted.push(hunk.path);
      continue;
    }

    if (hunk.type === APPLY_PATCH_HUNK_TYPES.UPDATE_FILE) {
      const existing = await readRequiredPatchFile(fileProvider, sourcePath, hunk.path, "update");
      const update = deriveNewContentsFromChunks(existing.content, hunk.chunks, hunk.path);
      let movePath = null;
      let absoluteMovePath = null;
      let overwrittenMoveContent = null;

      if (hunk.movePath) {
        const destinationPath = resolvePatchPath(hunk.movePath, {
          workingDirectory,
          allowAbsolutePaths
        });
        const destination = await readPatchFile(fileProvider, destinationPath, hunk.movePath);

        if (destination.isDirectory) {
          throw createApplyPatchApplicationError(`cannot move file over directory: ${hunk.movePath}`, {
            code: "path_is_directory",
            path: hunk.movePath
          });
        }

        movePath = hunk.movePath;
        absoluteMovePath = destinationPath.absolutePath;
        overwrittenMoveContent = destination.exists ? destination.content : null;
        assertSandboxWriteAllowed(sandboxPolicy, destinationPath.absolutePath);
      }

      changes.push({
        type: APPLY_PATCH_CHANGE_TYPES.UPDATE,
        path: hunk.path,
        absolutePath: sourcePath.absolutePath,
        movePath,
        absoluteMovePath,
        oldContent: update.originalContent,
        newContent: update.newContent,
        overwrittenMoveContent
      });
      assertSandboxWriteAllowed(sandboxPolicy, sourcePath.absolutePath);
      affected.modified.push(hunk.movePath ?? hunk.path);
      continue;
    }

    throw createApplyPatchApplicationError(`unsupported apply_patch hunk type: ${hunk.type}`);
  }

  return {
    dryRun: true,
    workingDirectory,
    patch: parsed.patch,
    environmentId: parsed.environmentId,
    changes,
    affected,
    summary: {
      ...parsed.summary,
      hunk_count: parsed.hunks.length,
      change_count: changes.length,
      environment_id: parsed.environmentId
    }
  };
}

function assertSandboxWriteAllowed(sandboxPolicy, absolutePath) {
  if (!sandboxPolicy) {
    return;
  }

  assertSandboxAllowed(sandboxPolicy.checkPath(absolutePath, SANDBOX_ACCESS_TYPES.WRITE));
}

export function deriveNewContentsFromChunks(originalContent, chunks, displayPath = "") {
  const originalLines = String(originalContent ?? "").split("\n");

  if (originalLines.at(-1) === "") {
    originalLines.pop();
  }

  const replacements = computeReplacements(originalLines, chunks, displayPath);
  const newLines = applyReplacements(originalLines, replacements);

  if (newLines.at(-1) !== "") {
    newLines.push("");
  }

  return {
    originalContent: String(originalContent ?? ""),
    newContent: newLines.join("\n"),
    replacements
  };
}

export function computeReplacements(originalLines, chunks, displayPath = "") {
  const replacements = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);

      if (contextIndex == null) {
        throw createApplyPatchApplicationError(
          `failed to find context '${chunk.changeContext}' in ${displayPath || "file"}`,
          {
            code: "context_not_found",
            path: displayPath
          }
        );
      }

      lineIndex = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex = originalLines.at(-1) === ""
        ? originalLines.length - 1
        : originalLines.length;
      replacements.push({
        start: insertionIndex,
        oldLength: 0,
        newLines: [...chunk.newLines]
      });
      continue;
    }

    let pattern = chunk.oldLines;
    let newLines = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);

    if (found == null && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);

      if (newLines.at(-1) === "") {
        newLines = newLines.slice(0, -1);
      }

      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found == null) {
      throw createApplyPatchApplicationError(
        `failed to find expected lines in ${displayPath || "file"}:\n${chunk.oldLines.join("\n")}`,
        {
          code: "expected_lines_not_found",
          path: displayPath
        }
      );
    }

    replacements.push({
      start: found,
      oldLength: pattern.length,
      newLines: [...newLines]
    });
    lineIndex = found + pattern.length;
  }

  return replacements.sort((left, right) => left.start - right.start);
}

export function applyReplacements(originalLines, replacements) {
  const lines = [...originalLines];

  for (const replacement of [...replacements].reverse()) {
    lines.splice(replacement.start, replacement.oldLength, ...replacement.newLines);
  }

  return lines;
}

export function seekSequence(lines, pattern, start = 0, eof = false) {
  if (pattern.length === 0) {
    return start;
  }

  if (pattern.length > lines.length) {
    return null;
  }

  const searchStart = eof && lines.length >= pattern.length
    ? lines.length - pattern.length
    : start;

  for (const matcher of [
    exactLineMatch,
    trimEndLineMatch,
    trimLineMatch,
    normalizedLineMatch
  ]) {
    for (let index = searchStart; index <= lines.length - pattern.length; index += 1) {
      if (pattern.every((line, offset) => matcher(lines[index + offset], line))) {
        return index;
      }
    }
  }

  return null;
}

export function resolvePatchPath(patchPath, options = {}) {
  const workingDirectory = normalizeWorkingDirectory(options.workingDirectory);
  const rawPath = String(patchPath ?? "");

  if (!rawPath.trim()) {
    throw createApplyPatchApplicationError("apply_patch path cannot be empty", {
      code: "empty_path"
    });
  }

  if (path.isAbsolute(rawPath) && !options.allowAbsolutePaths) {
    throw createApplyPatchApplicationError(`absolute apply_patch paths are not allowed: ${rawPath}`, {
      code: "absolute_path_not_allowed",
      path: rawPath
    });
  }

  const absolutePath = path.resolve(workingDirectory, rawPath);
  const relativePath = path.relative(workingDirectory, absolutePath);

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw createApplyPatchApplicationError(`apply_patch path escapes working directory: ${rawPath}`, {
      code: "path_outside_working_directory",
      path: rawPath
    });
  }

  return {
    path: rawPath,
    absolutePath,
    relativePath
  };
}

export function normalizeWorkingDirectory(workingDirectory = process.cwd()) {
  return path.resolve(String(workingDirectory || process.cwd()));
}

async function readRequiredPatchFile(fileProvider, resolvedPath, displayPath, operation) {
  const file = await readPatchFile(fileProvider, resolvedPath, displayPath);

  if (!file.exists) {
    throw createApplyPatchApplicationError(`failed to read file to ${operation}: ${displayPath}`, {
      code: "file_not_found",
      path: displayPath
    });
  }

  if (file.isDirectory) {
    throw createApplyPatchApplicationError(`cannot ${operation} directory: ${displayPath}`, {
      code: "path_is_directory",
      path: displayPath
    });
  }

  return file;
}

async function readPatchFile(fileProvider, resolvedPath, displayPath) {
  if (typeof fileProvider === "function") {
    return normalizePatchFile(await fileProvider({
      path: displayPath,
      absolutePath: resolvedPath.absolutePath,
      relativePath: resolvedPath.relativePath
    }));
  }

  const candidates = [
    resolvedPath.absolutePath,
    resolvedPath.relativePath,
    displayPath
  ];

  if (fileProvider instanceof Map) {
    for (const candidate of candidates) {
      if (fileProvider.has(candidate)) {
        return normalizePatchFile(fileProvider.get(candidate));
      }
    }
    return normalizePatchFile(null);
  }

  if (fileProvider && typeof fileProvider === "object") {
    for (const candidate of candidates) {
      if (Object.hasOwn(fileProvider, candidate)) {
        return normalizePatchFile(fileProvider[candidate]);
      }
    }
  }

  return normalizePatchFile(null);
}

function normalizePatchFile(value) {
  if (value == null) {
    return {
      exists: false,
      content: "",
      isDirectory: false
    };
  }

  if (typeof value === "string") {
    return {
      exists: true,
      content: value,
      isDirectory: false
    };
  }

  return {
    exists: value.exists ?? true,
    content: String(value.content ?? ""),
    isDirectory: value.isDirectory ?? false
  };
}

function exactLineMatch(left, right) {
  return left === right;
}

function trimEndLineMatch(left, right) {
  return left.trimEnd() === right.trimEnd();
}

function trimLineMatch(left, right) {
  return left.trim() === right.trim();
}

function normalizedLineMatch(left, right) {
  return normalizeFuzzyLine(left) === normalizeFuzzyLine(right);
}

function normalizeFuzzyLine(value) {
  return String(value ?? "")
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, "\"")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}
