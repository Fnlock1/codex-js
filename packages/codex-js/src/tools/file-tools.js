import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  SANDBOX_ACCESS_TYPES,
  SANDBOX_DECISIONS
} from "../sandbox/policy.js";
import {
  TOOL_CALL_RESULT_STATUSES,
  createToolCallResult
} from "./runtime.js";

export class ReadFileToolHandler {
  constructor(options = {}) {
    this.workingDirectory = options.workingDirectory ?? process.cwd();
    this.sandboxPolicy = options.sandboxPolicy ?? null;
    this.maxBytes = options.maxBytes ?? 200_000;
  }

  async run(request, context = {}) {
    const filePath = resolveToolPath(request.arguments?.path, this.workingDirectory);
    const sandbox = checkToolPath(context.sandboxPolicy ?? this.sandboxPolicy, filePath, SANDBOX_ACCESS_TYPES.READ);

    if (sandbox?.decision === SANDBOX_DECISIONS.DENY) {
      return sandboxBlockedResult(request, sandbox);
    }

    try {
      const content = await readFile(filePath, "utf8");
      const truncated = Buffer.byteLength(content, "utf8") > this.maxBytes;
      const output = truncated
        ? content.slice(0, this.maxBytes)
        : content;

      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        output,
        raw: {
          path: filePath,
          truncated,
          bytes: Buffer.byteLength(content, "utf8")
        }
      });
    } catch (error) {
      return fileToolError(request, error);
    }
  }
}

export class ListFilesToolHandler {
  constructor(options = {}) {
    this.workingDirectory = options.workingDirectory ?? process.cwd();
    this.sandboxPolicy = options.sandboxPolicy ?? null;
    this.maxEntries = options.maxEntries ?? 500;
  }

  async run(request, context = {}) {
    const directory = resolveToolPath(request.arguments?.path ?? ".", this.workingDirectory);
    const recursive = Boolean(request.arguments?.recursive ?? false);
    const limit = Number(request.arguments?.limit ?? this.maxEntries);
    const sandbox = checkToolPath(context.sandboxPolicy ?? this.sandboxPolicy, directory, SANDBOX_ACCESS_TYPES.READ);

    if (sandbox?.decision === SANDBOX_DECISIONS.DENY) {
      return sandboxBlockedResult(request, sandbox);
    }

    try {
      const entries = await listFiles(directory, {
        recursive,
        limit: Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : this.maxEntries,
        root: directory,
        sandboxPolicy: context.sandboxPolicy ?? this.sandboxPolicy
      });

      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        output: entries.map((entry) => entry.path).join("\n"),
        raw: {
          path: directory,
          entries
        }
      });
    } catch (error) {
      return fileToolError(request, error);
    }
  }
}

export class SearchFilesToolHandler {
  constructor(options = {}) {
    this.workingDirectory = options.workingDirectory ?? process.cwd();
    this.sandboxPolicy = options.sandboxPolicy ?? null;
    this.maxMatches = options.maxMatches ?? 200;
  }

  async run(request, context = {}) {
    const query = String(request.arguments?.query ?? "");
    const directory = resolveToolPath(request.arguments?.path ?? ".", this.workingDirectory);
    const limit = Number(request.arguments?.limit ?? this.maxMatches);
    const sandbox = checkToolPath(context.sandboxPolicy ?? this.sandboxPolicy, directory, SANDBOX_ACCESS_TYPES.READ);

    if (!query) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: "search_files requires a query.",
        error: "missing_query"
      });
    }

    if (sandbox?.decision === SANDBOX_DECISIONS.DENY) {
      return sandboxBlockedResult(request, sandbox);
    }

    try {
      const files = await listFiles(directory, {
        recursive: true,
        limit: 5_000,
        root: directory,
        sandboxPolicy: context.sandboxPolicy ?? this.sandboxPolicy
      });
      const matches = [];
      const maxMatches = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : this.maxMatches;

      for (const file of files) {
        if (file.type !== "file") {
          continue;
        }

        const content = await readFile(file.absolutePath, "utf8").catch(() => null);

        if (content == null) {
          continue;
        }

        const lines = content.split(/\r?\n/u);

        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].includes(query)) {
            continue;
          }

          matches.push({
            path: file.path,
            line: index + 1,
            text: lines[index]
          });

          if (matches.length >= maxMatches) {
            break;
          }
        }

        if (matches.length >= maxMatches) {
          break;
        }
      }

      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        output: matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n"),
        raw: {
          query,
          path: directory,
          matches
        }
      });
    } catch (error) {
      return fileToolError(request, error);
    }
  }
}

export function resolveToolPath(value, workingDirectory = process.cwd()) {
  const raw = String(value ?? ".");
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(workingDirectory, raw));
}

async function listFiles(directory, options = {}) {
  const entries = [];

  await walk(directory);
  return entries;

  async function walk(current) {
    if (entries.length >= options.limit) {
      return;
    }

    const children = await readdir(current, {
      withFileTypes: true
    });

    for (const child of children) {
      if (entries.length >= options.limit) {
        return;
      }

      const absolutePath = path.join(current, child.name);
      const sandbox = checkToolPath(options.sandboxPolicy, absolutePath, SANDBOX_ACCESS_TYPES.READ);

      if (sandbox?.decision === SANDBOX_DECISIONS.DENY) {
        continue;
      }

      const entry = {
        path: path.relative(options.root, absolutePath) || child.name,
        absolutePath,
        type: child.isDirectory() ? "directory" : "file"
      };

      entries.push(entry);

      if (options.recursive && child.isDirectory()) {
        await walk(absolutePath);
      }
    }
  }
}

function checkToolPath(sandboxPolicy, filePath, accessType) {
  return sandboxPolicy
    ? sandboxPolicy.checkPath(filePath, accessType)
    : null;
}

function sandboxBlockedResult(request, sandbox) {
  return createToolCallResult({
    callId: request.call_id,
    name: request.name,
    status: TOOL_CALL_RESULT_STATUSES.FAILED,
    output: `sandbox blocked: ${sandbox.reason}`,
    error: "sandbox_denied",
    raw: {
      sandbox
    }
  });
}

function fileToolError(request, error) {
  return createToolCallResult({
    callId: request.call_id,
    name: request.name,
    status: TOOL_CALL_RESULT_STATUSES.FAILED,
    output: error?.message ?? String(error),
    error: error?.code ?? "file_tool_error"
  });
}
