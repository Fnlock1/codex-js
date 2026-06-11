/**
 * 中文模块说明：src/apply-patch/runtime.js
 *
 * 解析、规划和执行 apply_patch 文件补丁。
 */
import { parseApplyPatch } from "./parser.js";
import {
  ApplyPatchApplicationError,
  computeApplyPatchPlan
} from "./apply.js";
import {
  RealApplyPatchFsRuntime,
  createNodeApplyPatchFileProvider
} from "./fs-runtime.js";

/**
 * 处理 summarize apply patch 相关逻辑。
 *
 * @param {unknown} parsed - parsed 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function summarizeApplyPatch(parsed) {
  return {
    ...parsed.summary,
    hunk_count: parsed.hunks.length,
    environment_id: parsed.environmentId
  };
}

/**
 * 创建 create apply patch dry run result 相关数据。
 *
 * @param {unknown} parsed - parsed 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createApplyPatchDryRunResult(parsed) {
  const summary = summarizeApplyPatch(parsed);

  return {
    status: "completed",
    output: [
      "apply_patch parsed successfully; patch was not applied.",
      `files: ${summary.files.join(", ") || "(none)"}`,
      `add=${summary.add} delete=${summary.delete} update=${summary.update} move=${summary.move}`
    ].join("\n"),
    raw: {
      dry_run: true,
      apply_patch: {
        patch: parsed.patch,
        summary,
        hunks: parsed.hunks
      }
    }
  };
}

/**
 * 创建 create apply patch parse failure 相关数据。
 *
 * @param {unknown} error - error 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createApplyPatchParseFailure(error) {
  return {
    status: "failed",
    output: `apply_patch parse error: ${error?.message ?? String(error)}`,
    error: "parse_error",
    raw: {
      dry_run: true,
      apply_patch: {
        parse_error: {
          message: error?.message ?? String(error),
          line_number: error?.lineNumber ?? null
        }
      }
    }
  };
}

/**
 * 创建 create apply patch dry run from text 相关数据。
 *
 * @param {unknown} patchText - patchText 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createApplyPatchDryRunFromText(patchText) {
  try {
    return createApplyPatchDryRunResult(parseApplyPatch(patchText));
  } catch (error) {
    return createApplyPatchParseFailure(error);
  }
}

/**
 * 创建 create apply patch plan from text 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} patchText - patchText 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function createApplyPatchPlanFromText(patchText, options = {}) {
  try {
    const parsed = parseApplyPatch(patchText);
    const plan = await computeApplyPatchPlan(parsed, options);

    return createApplyPatchPlanResult(parsed, plan);
  } catch (error) {
    if (error instanceof ApplyPatchApplicationError) {
      return createApplyPatchApplicationFailure(error);
    }

    return createApplyPatchParseFailure(error);
  }
}

/**
 * 创建 create apply patch plan result 相关数据。
 *
 * @param {unknown} parsed - parsed 参数。
 * @param {unknown} plan - plan 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createApplyPatchPlanResult(parsed, plan) {
  const summary = summarizeApplyPatch(parsed);

  return {
    status: "completed",
    output: [
      "apply_patch plan computed successfully; patch was not applied.",
      `files: ${summary.files.join(", ") || "(none)"}`,
      `add=${summary.add} delete=${summary.delete} update=${summary.update} move=${summary.move}`
    ].join("\n"),
    raw: {
      dry_run: true,
      apply_patch: {
        patch: parsed.patch,
        summary: {
          ...summary,
          change_count: plan.changes.length
        },
        hunks: parsed.hunks,
        plan
      }
    }
  };
}

/**
 * 创建 create apply patch application failure 相关数据。
 *
 * @param {unknown} error - error 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createApplyPatchApplicationFailure(error) {
  return {
    status: "failed",
    output: `apply_patch application error: ${error?.message ?? String(error)}`,
    error: error?.code ?? "apply_patch_application_error",
    raw: {
      dry_run: true,
      apply_patch: {
        application_error: {
          message: error?.message ?? String(error),
          code: error?.code ?? "apply_patch_application_error",
          path: error?.path ?? null
        }
      }
    }
  };
}

/**
 * 创建 create apply patch apply from text 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} patchText - patchText 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function createApplyPatchApplyFromText(patchText, options = {}) {
  try {
    const parsed = parseApplyPatch(patchText);
    const workingDirectory = options.workingDirectory;
    const fileProvider = options.fileProvider ?? createNodeApplyPatchFileProvider();
    const plan = await computeApplyPatchPlan(parsed, {
      workingDirectory,
      fileProvider,
      allowAbsolutePaths: false,
      sandboxPolicy: options.sandboxPolicy ?? null
    });
    const fsRuntime = options.fsRuntime ?? new RealApplyPatchFsRuntime({
      allowWrites: options.allowWrites ?? false
    });
    const fsResult = await fsRuntime.run(plan, {
      allowWrites: options.allowWrites ?? false
    });

    if (fsResult.error) {
      return createApplyPatchWriteFailure(fsResult);
    }

    return createApplyPatchWriteResult(parsed, plan, fsResult);
  } catch (error) {
    if (error instanceof ApplyPatchApplicationError) {
      return createApplyPatchApplicationFailure(error);
    }

    return createApplyPatchParseFailure(error);
  }
}

/**
 * 创建 create apply patch write result 相关数据。
 *
 * @param {unknown} parsed - parsed 参数。
 * @param {unknown} plan - plan 参数。
 * @param {unknown} fsResult - fsResult 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createApplyPatchWriteResult(parsed, plan, fsResult) {
  const summary = summarizeApplyPatch(parsed);

  return {
    status: "completed",
    output: fsResult.output,
    raw: {
      dry_run: false,
      apply_patch: {
        patch: parsed.patch,
        summary: {
          ...summary,
          change_count: plan.changes.length
        },
        hunks: parsed.hunks,
        plan,
        fs: fsResult
      }
    }
  };
}

/**
 * 创建 create apply patch write failure 相关数据。
 *
 * @param {unknown} fsResult - fsResult 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createApplyPatchWriteFailure(fsResult) {
  return {
    status: "failed",
    output: fsResult.output,
    error: fsResult.error ?? "apply_patch_write_error",
    raw: {
      dry_run: true,
      apply_patch: {
        write_error: {
          message: fsResult.output,
          code: fsResult.error ?? "apply_patch_write_error",
          committed_changes: fsResult.committed_changes ?? []
        },
        plan: fsResult.plan ?? null
      }
    }
  };
}
