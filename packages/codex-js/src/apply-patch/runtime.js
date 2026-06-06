import { parseApplyPatch } from "./parser.js";
import {
  ApplyPatchApplicationError,
  computeApplyPatchPlan
} from "./apply.js";
import {
  RealApplyPatchFsRuntime,
  createNodeApplyPatchFileProvider
} from "./fs-runtime.js";

export function summarizeApplyPatch(parsed) {
  return {
    ...parsed.summary,
    hunk_count: parsed.hunks.length,
    environment_id: parsed.environmentId
  };
}

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

export function createApplyPatchDryRunFromText(patchText) {
  try {
    return createApplyPatchDryRunResult(parseApplyPatch(patchText));
  } catch (error) {
    return createApplyPatchParseFailure(error);
  }
}

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
