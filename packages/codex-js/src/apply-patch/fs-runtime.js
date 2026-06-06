import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const APPLY_PATCH_WRITE_DECISIONS = Object.freeze({
  ALLOW: "allow",
  BLOCK: "block"
});

export class ApplyPatchWriteError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApplyPatchWriteError";
    this.code = options.code ?? "apply_patch_write_error";
    this.path = options.path ?? null;
    this.committedChanges = options.committedChanges ?? [];
  }
}

export class ApplyPatchFsRuntime {
  async run(_plan, _options = {}) {
    throw new Error("ApplyPatchFsRuntime.run() must be implemented by a subclass.");
  }
}

export class BlockedApplyPatchFsRuntime extends ApplyPatchFsRuntime {
  async run(plan) {
    return createApplyPatchFsResult({
      plan,
      applied: false,
      error: "writes_not_allowed",
      output: "apply_patch writes are not allowed; patch was not applied."
    });
  }
}

export class RealApplyPatchFsRuntime extends ApplyPatchFsRuntime {
  constructor(options = {}) {
    super();
    this.allowWrites = options.allowWrites ?? false;
  }

  async run(plan, options = {}) {
    if (!(options.allowWrites ?? this.allowWrites)) {
      return new BlockedApplyPatchFsRuntime().run(plan);
    }

    try {
      const result = await applyApplyPatchPlan(plan, {
        allowWrites: true
      });

      return createApplyPatchFsResult({
        plan,
        applied: true,
        changes: result.changes,
        output: formatApplyPatchSuccessOutput(plan)
      });
    } catch (error) {
      return createApplyPatchFsResult({
        plan,
        applied: false,
        error: error?.code ?? "apply_patch_write_error",
        output: `apply_patch write error: ${error?.message ?? String(error)}`,
        committedChanges: error?.committedChanges ?? []
      });
    }
  }
}

export async function applyApplyPatchPlan(plan, options = {}) {
  if (!options.allowWrites) {
    throw createApplyPatchWriteError("apply_patch writes are not allowed", {
      code: "writes_not_allowed"
    });
  }

  const committedChanges = [];

  for (const change of plan.changes) {
    try {
      if (change.type === "add") {
        await writeTextFileCreatingParents(change.absolutePath, change.content);
        committedChanges.push(change);
        continue;
      }

      if (change.type === "delete") {
        await unlink(change.absolutePath);
        committedChanges.push(change);
        continue;
      }

      if (change.type === "update") {
        if (change.absoluteMovePath) {
          await writeTextFileCreatingParents(change.absoluteMovePath, change.newContent);
          await unlink(change.absolutePath);
        } else {
          await writeTextFileCreatingParents(change.absolutePath, change.newContent);
        }

        committedChanges.push(change);
        continue;
      }

      throw createApplyPatchWriteError(`unsupported apply_patch change type: ${change.type}`, {
        code: "unsupported_change_type",
        committedChanges
      });
    } catch (error) {
      throw createApplyPatchWriteError(error?.message ?? String(error), {
        code: error?.code === "ENOENT" ? "file_not_found" : error?.code ?? "apply_patch_write_error",
        path: change.path,
        committedChanges
      });
    }
  }

  return {
    applied: true,
    changes: committedChanges,
    summary: plan.summary
  };
}

export function createNodeApplyPatchFileProvider() {
  return async ({ absolutePath }) => {
    try {
      const metadata = await stat(absolutePath);

      if (metadata.isDirectory()) {
        return {
          exists: true,
          content: "",
          isDirectory: true
        };
      }

      return {
        exists: true,
        content: await readFile(absolutePath, "utf8"),
        isDirectory: false
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          exists: false,
          content: "",
          isDirectory: false
        };
      }

      throw error;
    }
  };
}

export function createApplyPatchFsResult(options = {}) {
  return {
    applied: options.applied ?? false,
    dry_run: !(options.applied ?? false),
    output: String(options.output ?? ""),
    error: options.error ?? null,
    changes: options.changes ?? [],
    committed_changes: options.committedChanges ?? options.changes ?? [],
    plan: options.plan ?? null
  };
}

export function formatApplyPatchSuccessOutput(plan) {
  const lines = ["Success. Updated the following files:"];

  for (const file of plan.affected.added) {
    lines.push(`A ${file}`);
  }

  for (const file of plan.affected.modified) {
    lines.push(`M ${file}`);
  }

  for (const file of plan.affected.deleted) {
    lines.push(`D ${file}`);
  }

  return lines.join("\n");
}

export function createApplyPatchWriteError(message, options = {}) {
  return new ApplyPatchWriteError(message, options);
}

async function writeTextFileCreatingParents(filePath, content) {
  await mkdir(path.dirname(filePath), {
    recursive: true
  });
  await writeFile(filePath, content, "utf8");
}
