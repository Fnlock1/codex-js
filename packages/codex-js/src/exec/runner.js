import {
  ITEM_STATUSES,
  createExecToolCallOutput,
  createItemCompletedEvent,
  createItemStartedEvent,
  createCommandExecutionItem
} from "../protocol/index.js";
import {
  SANDBOX_DECISIONS
} from "../sandbox/policy.js";
import {
  EXEC_POLICY_DECISIONS,
  ExecPermissionPolicy,
  itemStatusForPolicyDecision
} from "./permission-policy.js";
import {
  DryRunExecRuntime,
  blockedExecResult,
  createExecRequest
} from "./runtime.js";

export class ExecRunner {
  constructor(options = {}) {
    this.workingDirectory = options.workingDirectory ?? process.cwd();
    this.permissionPolicy = options.permissionPolicy ?? new ExecPermissionPolicy({
      defaultDecision: EXEC_POLICY_DECISIONS.ALLOW,
      approvalGate: options.approvalGate
    });
    this.runtime = options.runtime ?? new DryRunExecRuntime();
    this.sandboxPolicy = options.sandboxPolicy ?? null;
  }

  async *runDryCommand(request) {
    return yield* this.runCommand(request);
  }

  async *runCommand(request) {
    const normalized = normalizeExecRequest(request, {
      workingDirectory: this.workingDirectory
    });
    const execRequest = createExecRequest({
      command: normalized.command,
      argv: normalized.argv,
      cwd: normalized.cwd,
      timeoutMs: normalized.timeoutMs,
      env: normalized.env
    });
    const permission = this.permissionPolicy.check(normalized);
    const startedItem = createCommandExecutionItem({
      command: execRequest.command,
      cwd: execRequest.cwd,
      status: ITEM_STATUSES.IN_PROGRESS
    });
    yield createItemStartedEvent(startedItem);

    if (this.sandboxPolicy) {
      const sandbox = this.sandboxPolicy.checkExec(execRequest);

      if (sandbox.decision !== SANDBOX_DECISIONS.ALLOW) {
        const blockedOutput = createExecToolCallOutput({
          stderr: `sandbox blocked: ${sandbox.reason}`,
          exitCode: 1,
          durationMs: 0
        });
        const result = blockedExecResult({
          decision: "sandbox",
          output: blockedOutput
        });
        const blockedItem = createCommandExecutionItem({
          id: startedItem.id,
          command: execRequest.command,
          cwd: execRequest.cwd,
          status: ITEM_STATUSES.FAILED,
          output: result.output
        });

        yield createItemCompletedEvent(blockedItem);
        return {
          ...result,
          sandbox
        };
      }
    }

    if (permission.decision !== EXEC_POLICY_DECISIONS.ALLOW) {
      const blockedOutput = createExecToolCallOutput({
        stderr: `dry-run blocked: ${permission.decision}`,
        exitCode: 1,
        durationMs: 0
      });
      const result = blockedExecResult({
        decision: permission.decision,
        output: blockedOutput
      });
      const blockedItem = createCommandExecutionItem({
        id: startedItem.id,
        command: execRequest.command,
        cwd: execRequest.cwd,
        status: itemStatusForPolicyDecision(permission.decision),
        output: result.output,
        approvalRequest: permission.approvalRequest
      });

      yield createItemCompletedEvent(blockedItem);
      return result;
    }

    const result = await this.runtime.run(execRequest);
    const completedStatus = result.error || result.output.exit_code !== 0
      ? ITEM_STATUSES.FAILED
      : ITEM_STATUSES.COMPLETED;
    const completedItem = createCommandExecutionItem({
      id: startedItem.id,
      command: execRequest.command,
      cwd: execRequest.cwd,
      status: completedStatus,
      output: result.output
    });

    yield createItemCompletedEvent(completedItem);

    return result;
  }
}

export function normalizeExecRequest(request, defaults = {}) {
  if (typeof request === "string") {
    return {
      command: request,
      cwd: defaults.workingDirectory ?? process.cwd(),
      timeoutMs: null,
      env: null
    };
  }

  if (!request || typeof request !== "object") {
    throw new TypeError("Exec request must be a command string or object.");
  }

  const normalized = {
    command: Array.isArray(request.command)
      ? request.command.map(String).join(" ")
      : String(request.command ?? ""),
    cwd: request.cwd ?? defaults.workingDirectory ?? process.cwd(),
    timeoutMs: request.timeoutMs ?? request.timeout_ms ?? null,
    env: request.env ?? null
  };

  if (Array.isArray(request.argv)) {
    normalized.argv = request.argv.map(String);
  } else if (Array.isArray(request.command)) {
    normalized.argv = request.command.map(String);
  }

  return normalized;
}
