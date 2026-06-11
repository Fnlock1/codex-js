/**
 * 中文模块说明：src/tools/git-tools.js
 *
 * 工具定义、路由、handler、内置工具和上游工具格式转换。
 */
import {
  APPROVAL_DECISIONS
} from "../approval/policy.js";
import { ExecRunner } from "../exec/runner.js";
import {
  checkCapabilityApproval,
  createCapabilityDecision,
  createExecCapabilityRequest
} from "../policy/capability.js";
import {
  TOOL_CALL_RESULT_STATUSES,
  createToolCallResult
} from "./runtime.js";

/**
 * 定义 GitStatusToolHandler 类，封装当前模块的状态和行为。
 */
export class GitStatusToolHandler {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.execRunner = options.execRunner ?? new ExecRunner({
      workingDirectory: options.workingDirectory,
      approvalGate: options.approvalGate,
      sandboxPolicy: options.sandboxPolicy
    });
    this.approvalGate = options.approvalGate ?? null;
    this.requiresApproval = Boolean(options.requiresApproval ?? false);
  }

  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} request - request 参数。
   * @param {unknown} context - context 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async run(request, context = {}) {
    return await runGitCommand(request, this.execRunner, {
      command: "git status --short --branch",
      cwd: request.arguments?.cwd ?? context.turnContext?.workingDirectory,
      approvalGate: this.requiresApproval ? this.approvalGate ?? context.approvalGate ?? null : null
    });
  }
}

/**
 * 定义 GitDiffToolHandler 类，封装当前模块的状态和行为。
 */
export class GitDiffToolHandler {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.execRunner = options.execRunner ?? new ExecRunner({
      workingDirectory: options.workingDirectory,
      approvalGate: options.approvalGate,
      sandboxPolicy: options.sandboxPolicy
    });
    this.approvalGate = options.approvalGate ?? null;
    this.requiresApproval = Boolean(options.requiresApproval ?? false);
  }

  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} request - request 参数。
   * @param {unknown} context - context 参数。
   * @returns {unknown} 返回处理后的结果。
   */
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

/**
 * 执行 run git command 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} request - request 参数。
 * @param {unknown} execRunner - execRunner 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
async function runGitCommand(request, execRunner, options = {}) {
  const capabilityRequest = createExecCapabilityRequest({
    command: options.command,
    cwd: options.cwd ?? null,
    tool: request.name,
    arguments: request.arguments
  });

  if (options.approvalGate) {
    const approval = await checkCapabilityApproval(capabilityRequest, options.approvalGate);
    const capability = createCapabilityDecision({
      decision: capabilityDecisionFromApproval(approval),
      request: capabilityRequest,
      approval
    });

    if (approval.decision !== APPROVAL_DECISIONS.ALLOW) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: `git command blocked: ${approval.decision}`,
        error: `blocked: ${approval.decision}`,
        raw: {
          capability,
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
      capability: createCapabilityDecision({
        request: capabilityRequest,
        decision: "allow"
      }),
      git: result
    }
  });
}

/**
 * 处理 quote pathspec 相关逻辑。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function quotePathspec(value) {
  return `"${String(value).replaceAll("\"", "\\\"")}"`;
}

function capabilityDecisionFromApproval(approval) {
  if (approval?.decision === APPROVAL_DECISIONS.ALLOW) {
    return "allow";
  }

  if (approval?.decision === APPROVAL_DECISIONS.PROMPT) {
    return "prompt";
  }

  return "deny";
}
