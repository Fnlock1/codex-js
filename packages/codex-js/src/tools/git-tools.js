import {
  APPROVAL_ACTIONS,
  APPROVAL_DECISIONS,
  APPROVAL_RESOURCE_TYPES
} from "../approval/policy.js";
import { ExecRunner } from "../exec/runner.js";
import {
  TOOL_CALL_RESULT_STATUSES,
  createToolCallResult
} from "./runtime.js";

export class GitStatusToolHandler {
  constructor(options = {}) {
    this.execRunner = options.execRunner ?? new ExecRunner({
      workingDirectory: options.workingDirectory,
      approvalGate: options.approvalGate,
      sandboxPolicy: options.sandboxPolicy
    });
    this.approvalGate = options.approvalGate ?? null;
    this.requiresApproval = Boolean(options.requiresApproval ?? false);
  }

  async run(request, context = {}) {
    return await runGitCommand(request, this.execRunner, {
      command: "git status --short --branch",
      cwd: request.arguments?.cwd ?? context.turnContext?.workingDirectory,
      approvalGate: this.requiresApproval ? this.approvalGate ?? context.approvalGate ?? null : null
    });
  }
}

export class GitDiffToolHandler {
  constructor(options = {}) {
    this.execRunner = options.execRunner ?? new ExecRunner({
      workingDirectory: options.workingDirectory,
      approvalGate: options.approvalGate,
      sandboxPolicy: options.sandboxPolicy
    });
    this.approvalGate = options.approvalGate ?? null;
    this.requiresApproval = Boolean(options.requiresApproval ?? false);
  }

  async run(request, context = {}) {
    const staged = Boolean(request.arguments?.staged ?? false);
    const pathspec = request.arguments?.path ? ` -- ${quotePathspec(request.arguments.path)}` : "";
    const command = staged
      ? `git diff --staged${pathspec}`
      : `git diff${pathspec}`;

    return await runGitCommand(request, this.execRunner, {
      command,
      cwd: request.arguments?.cwd ?? context.turnContext?.workingDirectory,
      approvalGate: this.requiresApproval ? this.approvalGate ?? context.approvalGate ?? null : null
    });
  }
}

async function runGitCommand(request, execRunner, options = {}) {
  if (options.approvalGate) {
    const approval = await options.approvalGate.check({
      resourceType: APPROVAL_RESOURCE_TYPES.EXEC,
      action: APPROVAL_ACTIONS.EXECUTE,
      subject: options.command,
      description: `Execute command: ${options.command}`,
      metadata: {
        command: options.command,
        cwd: options.cwd ?? null,
        tool: request.name
      }
    });

    if (approval.decision !== APPROVAL_DECISIONS.ALLOW) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: `git command blocked: ${approval.decision}`,
        error: `blocked: ${approval.decision}`,
        raw: {
          approval
        }
      });
    }
  }

  const iterator = execRunner.runCommand({
    command: options.command,
    cwd: options.cwd
  });
  let next = await iterator.next();

  while (!next.done) {
    next = await iterator.next();
  }

  const result = next.value ?? null;

  return createToolCallResult({
    callId: request.call_id,
    name: request.name,
    status: result?.error ? TOOL_CALL_RESULT_STATUSES.FAILED : TOOL_CALL_RESULT_STATUSES.COMPLETED,
    output: result?.output?.aggregated_output?.text ?? "",
    error: result?.error ?? null,
    raw: {
      git: result
    }
  });
}

function quotePathspec(value) {
  return `"${String(value).replaceAll("\"", "\\\"")}"`;
}
