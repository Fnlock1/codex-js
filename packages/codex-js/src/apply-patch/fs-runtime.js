/**
 * 中文模块说明：src/apply-patch/fs-runtime.js
 *
 * 解析、规划和执行 apply_patch 文件补丁。
 */
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const APPLY_PATCH_WRITE_DECISIONS = Object.freeze({
  ALLOW: "allow",
  BLOCK: "block"
});

/**
 * 定义 ApplyPatchWriteError 类，封装当前模块的状态和行为。
 */
export class ApplyPatchWriteError extends Error {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} message - message 参数。
   * @param {unknown} options - options 参数。
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "ApplyPatchWriteError";
    this.code = options.code ?? "apply_patch_write_error";
    this.path = options.path ?? null;
    this.committedChanges = options.committedChanges ?? [];
  }
}

/**
 * 定义 ApplyPatchFsRuntime 类，封装当前模块的状态和行为。
 */
export class ApplyPatchFsRuntime {
  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} _plan - _plan 参数。
   * @param {unknown} _options - _options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async run(_plan, _options = {}) {
    throw new Error("ApplyPatchFsRuntime.run() must be implemented by a subclass.");
  }
}

/**
 * 定义 BlockedApplyPatchFsRuntime 类，封装当前模块的状态和行为。
 */
export class BlockedApplyPatchFsRuntime extends ApplyPatchFsRuntime {
  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} plan - plan 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async run(plan) {
    return createApplyPatchFsResult({
      plan,
      applied: false,
      error: "writes_not_allowed",
      output: "apply_patch writes are not allowed; patch was not applied."
    });
  }
}

/**
 * 定义 RealApplyPatchFsRuntime 类，封装当前模块的状态和行为。
 */
export class RealApplyPatchFsRuntime extends ApplyPatchFsRuntime {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    super();
    this.allowWrites = options.allowWrites ?? false;
  }

  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} plan - plan 参数。
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
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

/**
 * 应用 apply apply patch plan 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} plan - plan 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 创建 create node apply patch file provider 相关数据。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 创建 create apply patch fs result 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 格式化 format apply patch success output 相关数据。
 *
 * @param {unknown} plan - plan 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 创建 create apply patch write error 相关数据。
 *
 * @param {unknown} message - message 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createApplyPatchWriteError(message, options = {}) {
  return new ApplyPatchWriteError(message, options);
}

/**
 * 写入 write text file creating parents 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} filePath - filePath 参数。
 * @param {unknown} content - content 参数。
 * @returns {unknown} 返回处理后的结果。
 */
async function writeTextFileCreatingParents(filePath, content) {
  await mkdir(path.dirname(filePath), {
    recursive: true
  });
  await writeFile(filePath, content, "utf8");
}
