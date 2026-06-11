/**
 * 中文模块说明：src/exec/permission-policy.js
 *
 * 命令执行、PTY 会话、输出事件和执行权限策略。
 */
import { randomUUID } from "node:crypto";
import { ITEM_STATUSES } from "../protocol/index.js";
import {
  APPROVAL_ACTIONS,
  APPROVAL_DECISIONS,
  APPROVAL_RESOURCE_TYPES,
  ApprovalGate
} from "../approval/policy.js";
import { normalizeExecRequest } from "./runner.js";

export const EXEC_POLICY_DECISIONS = Object.freeze({
  ALLOW: "allow",
  PROMPT: "prompt",
  FORBIDDEN: "forbidden"
});

export const REVIEW_DECISIONS = Object.freeze({
  APPROVED: "approved",
  APPROVED_FOR_SESSION: "approved_for_session",
  DENIED: "denied",
  ABORT: "abort"
});

/**
 * 定义 ExecPermissionPolicy 类，封装当前模块的状态和行为。
 */
export class ExecPermissionPolicy {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.prefixRules = normalizePrefixRules(options.prefixRules ?? []);
    this.defaultDecision = options.defaultDecision ?? EXEC_POLICY_DECISIONS.PROMPT;
    this.approvalGate = options.approvalGate ?? null;
  }

  /**
   * 处理 check 相关逻辑。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  check(request) {
    const normalized = normalizeExecRequest(request);
    const tokens = tokenizeCommand(normalized.command);
    const approvalRequest = createExecApprovalRequest({
      command: normalized.command,
      cwd: normalized.cwd,
      parsedCommand: tokens
    });

    if (this.approvalGate) {
      const gateResult = this.approvalGate.check(createExecApprovalGateRequest(normalized));
      return {
        decision: execDecisionFromApprovalDecision(gateResult.decision),
        command: normalized.command,
        cwd: normalized.cwd,
        tokens,
        matchedRule: gateResult.matchedRule,
        approvalRequest: gateResult.approvalRequest
          ? {
              ...approvalRequest,
              approval: gateResult.approvalRequest
            }
          : null
      };
    }

    const matchedRule = firstMatchingRule(tokens, this.prefixRules);
    const decision = matchedRule?.decision ?? this.defaultDecision;

    return {
      decision,
      command: normalized.command,
      cwd: normalized.cwd,
      tokens,
      matchedRule: matchedRule ?? null,
      approvalRequest: decision === EXEC_POLICY_DECISIONS.PROMPT
        ? createExecApprovalRequest({
            command: normalized.command,
            cwd: normalized.cwd,
            parsedCommand: tokens
          })
        : null
    };
  }

  /**
   * 处理 allow prefixes 相关逻辑。
   *
   * @param {unknown} prefixes - prefixes 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  static allowPrefixes(prefixes) {
    return new ExecPermissionPolicy({
      prefixRules: prefixes.map((prefix) => ({
        prefix,
        decision: EXEC_POLICY_DECISIONS.ALLOW
      }))
    });
  }
}

/**
 * 创建 create exec approval request 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createExecApprovalRequest(options) {
  return {
    type: "exec_approval_request",
    id: options.id ?? randomUUID(),
    call_id: options.callId ?? randomUUID(),
    command: String(options.command ?? ""),
    cwd: options.cwd ? String(options.cwd) : process.cwd(),
    parsed_cmd: Array.isArray(options.parsedCommand)
      ? options.parsedCommand
      : tokenizeCommand(options.command ?? ""),
    available_decisions: options.availableDecisions ?? [
      REVIEW_DECISIONS.APPROVED,
      REVIEW_DECISIONS.APPROVED_FOR_SESSION,
      REVIEW_DECISIONS.ABORT
    ],
    proposed_execpolicy_amendment: options.proposedExecPolicyAmendment ?? {
      command: Array.isArray(options.parsedCommand)
        ? options.parsedCommand
        : tokenizeCommand(options.command ?? "")
    }
  };
}

/**
 * 创建 create exec approval gate request 相关数据。
 *
 * @param {unknown} request - request 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createExecApprovalGateRequest(request) {
  const normalized = normalizeExecRequest(request);

  return {
    resourceType: APPROVAL_RESOURCE_TYPES.EXEC,
    action: APPROVAL_ACTIONS.EXECUTE,
    subject: normalized.command,
    description: `Execute command: ${normalized.command}`,
    metadata: {
      command: normalized.command,
      cwd: normalized.cwd,
      argv: normalized.argv ?? null,
      env: normalized.env ?? null
    }
  };
}

/**
 * 处理 exec decision from approval decision 相关逻辑。
 *
 * @param {unknown} decision - decision 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function execDecisionFromApprovalDecision(decision) {
  switch (decision) {
    case APPROVAL_DECISIONS.ALLOW:
      return EXEC_POLICY_DECISIONS.ALLOW;
    case APPROVAL_DECISIONS.FORBIDDEN:
      return EXEC_POLICY_DECISIONS.FORBIDDEN;
    case APPROVAL_DECISIONS.PROMPT:
    default:
      return EXEC_POLICY_DECISIONS.PROMPT;
  }
}

/**
 * 处理 item status for policy decision 相关逻辑。
 *
 * @param {unknown} decision - decision 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function itemStatusForPolicyDecision(decision) {
  switch (decision) {
    case EXEC_POLICY_DECISIONS.ALLOW:
      return ITEM_STATUSES.COMPLETED;
    case EXEC_POLICY_DECISIONS.FORBIDDEN:
      return ITEM_STATUSES.FAILED;
    case EXEC_POLICY_DECISIONS.PROMPT:
    default:
      return ITEM_STATUSES.FAILED;
  }
}

/**
 * 切分 tokenize command 相关数据。
 *
 * @param {unknown} command - command 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function tokenizeCommand(command) {
  return String(command ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * 归一化 normalize prefix rules 相关数据。
 *
 * @param {unknown} rules - rules 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizePrefixRules(rules) {
  return rules.map((rule) => ({
    prefix: Array.isArray(rule.prefix)
      ? rule.prefix.map(String)
      : tokenizeCommand(rule.prefix),
    decision: rule.decision ?? EXEC_POLICY_DECISIONS.ALLOW,
    justification: rule.justification
  }));
}

/**
 * 处理 first matching rule 相关逻辑。
 *
 * @param {unknown} tokens - tokens 参数。
 * @param {unknown} rules - rules 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function firstMatchingRule(tokens, rules) {
  return rules.find((rule) => prefixMatches(tokens, rule.prefix));
}

/**
 * 处理 prefix matches 相关逻辑。
 *
 * @param {unknown} tokens - tokens 参数。
 * @param {unknown} prefix - prefix 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function prefixMatches(tokens, prefix) {
  if (prefix.length === 0 || prefix.length > tokens.length) {
    return false;
  }

  return prefix.every((token, index) => token === tokens[index]);
}
