/**
 * 中文模块说明：src/approval/policy.js
 *
 * 高风险操作的审批策略和审批结果建模。
 */
import { randomUUID } from "node:crypto";

export const APPROVAL_RESOURCE_TYPES = Object.freeze({
  EXEC: "exec",
  APPLY_PATCH: "apply_patch",
  TOOL: "tool"
});

export const APPROVAL_ACTIONS = Object.freeze({
  EXECUTE: "execute",
  WRITE: "write",
  RUN: "run"
});

export const APPROVAL_DECISIONS = Object.freeze({
  ALLOW: "allow",
  PROMPT: "prompt",
  FORBIDDEN: "forbidden"
});

export const APPROVAL_REVIEW_DECISIONS = Object.freeze({
  APPROVED: "approved",
  APPROVED_FOR_SESSION: "approved_for_session",
  DENIED: "denied",
  ABORT: "abort"
});

/**
 * 定义 ApprovalPolicy 类，封装当前模块的状态和行为。
 */
export class ApprovalPolicy {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.rules = normalizeApprovalRules(options.rules ?? []);
    this.defaultDecision = options.defaultDecision ?? APPROVAL_DECISIONS.PROMPT;
    this.sessionApprovals = new Set(options.sessionApprovals ?? []);
  }

  /**
   * 处理 check 相关逻辑。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  check(request) {
    const normalized = normalizeApprovalRequest(request);
    const sessionKey = approvalSessionKey(normalized);

    if (this.sessionApprovals.has(sessionKey)) {
      return createApprovalResult({
        decision: APPROVAL_DECISIONS.ALLOW,
        request: normalized,
        matchedRule: {
          type: "session_approval",
          key: sessionKey
        }
      });
    }

    const matchedRule = firstMatchingApprovalRule(normalized, this.rules);
    const decision = matchedRule?.decision ?? this.defaultDecision;

    return createApprovalResult({
      decision,
      request: normalized,
      matchedRule
    });
  }

  /**
   * 处理 review 相关逻辑。
   *
   * @param {unknown} approvalRequest - approvalRequest 参数。
   * @param {unknown} decision - decision 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  review(approvalRequest, decision) {
    const normalizedDecision = String(decision ?? "");

    if (
      normalizedDecision === APPROVAL_REVIEW_DECISIONS.APPROVED ||
      normalizedDecision === APPROVAL_REVIEW_DECISIONS.APPROVED_FOR_SESSION
    ) {
      const request = normalizeApprovalRequest(approvalRequest.request ?? approvalRequest);

      if (normalizedDecision === APPROVAL_REVIEW_DECISIONS.APPROVED_FOR_SESSION) {
        this.sessionApprovals.add(approvalSessionKey(request));
      }

      return {
        decision: APPROVAL_DECISIONS.ALLOW,
        review_decision: normalizedDecision,
        request
      };
    }

    return {
      decision: APPROVAL_DECISIONS.FORBIDDEN,
      review_decision: normalizedDecision || APPROVAL_REVIEW_DECISIONS.DENIED,
      request: normalizeApprovalRequest(approvalRequest.request ?? approvalRequest)
    };
  }

  /**
   * 处理 approve for session 相关逻辑。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  approveForSession(request) {
    const normalized = normalizeApprovalRequest(request);
    this.sessionApprovals.add(approvalSessionKey(normalized));

    return normalized;
  }
}

/**
 * 定义 ApprovalGate 类，封装当前模块的状态和行为。
 */
export class ApprovalGate {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.policy = options.policy ?? new ApprovalPolicy(options);
  }

  /**
   * 处理 check 相关逻辑。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  check(request) {
    return this.policy.check(request);
  }

  /**
   * 处理 review 相关逻辑。
   *
   * @param {unknown} approvalRequest - approvalRequest 参数。
   * @param {unknown} decision - decision 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  review(approvalRequest, decision) {
    return this.policy.review(approvalRequest, decision);
  }

  /**
   * 处理 approve for session 相关逻辑。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  approveForSession(request) {
    return this.policy.approveForSession(request);
  }
}

/**
 * 创建 create approval request 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createApprovalRequest(options = {}) {
  const request = normalizeApprovalRequest(options.request ?? options);

  return {
    type: `${request.resource_type}_approval_request`,
    id: options.id ?? randomUUID(),
    call_id: options.callId ?? options.call_id ?? randomUUID(),
    resource_type: request.resource_type,
    action: request.action,
    subject: request.subject,
    description: options.description ?? request.description,
    request,
    available_decisions: options.availableDecisions ?? [
      APPROVAL_REVIEW_DECISIONS.APPROVED,
      APPROVAL_REVIEW_DECISIONS.APPROVED_FOR_SESSION,
      APPROVAL_REVIEW_DECISIONS.ABORT
    ],
    proposed_policy_amendment: options.proposedPolicyAmendment ?? {
      resource_type: request.resource_type,
      action: request.action,
      subject: request.subject
    }
  };
}

/**
 * 创建 create approval result 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createApprovalResult(options = {}) {
  const request = normalizeApprovalRequest(options.request);
  const decision = options.decision ?? APPROVAL_DECISIONS.PROMPT;

  return {
    decision,
    request,
    matchedRule: options.matchedRule ?? null,
    approvalRequest: decision === APPROVAL_DECISIONS.PROMPT
      ? createApprovalRequest({
          request
        })
      : null
  };
}

/**
 * 归一化 normalize approval request 相关数据。
 *
 * @param {unknown} request - request 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeApprovalRequest(request = {}) {
  return {
    resource_type: String(request.resourceType ?? request.resource_type ?? APPROVAL_RESOURCE_TYPES.TOOL),
    action: String(request.action ?? APPROVAL_ACTIONS.RUN),
    subject: String(request.subject ?? ""),
    description: request.description == null ? null : String(request.description),
    metadata: request.metadata ?? {}
  };
}

/**
 * 处理 approval session key 相关逻辑。
 *
 * @param {unknown} request - request 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function approvalSessionKey(request) {
  const normalized = normalizeApprovalRequest(request);
  return [
    normalized.resource_type,
    normalized.action,
    normalized.subject
  ].join("\u001f");
}

/**
 * 归一化 normalize approval rules 相关数据。
 *
 * @param {unknown} rules - rules 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeApprovalRules(rules) {
  return rules.map((rule) => ({
    resource_type: rule.resourceType ?? rule.resource_type ?? null,
    action: rule.action ?? null,
    subject: rule.subject ?? null,
    subjectPrefix: rule.subjectPrefix ?? rule.subject_prefix ?? null,
    decision: rule.decision ?? APPROVAL_DECISIONS.ALLOW,
    justification: rule.justification ?? null
  }));
}

/**
 * 处理 first matching approval rule 相关逻辑。
 *
 * @param {unknown} request - request 参数。
 * @param {unknown} rules - rules 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function firstMatchingApprovalRule(request, rules) {
  return rules.find((rule) => approvalRuleMatches(request, rule)) ?? null;
}

/**
 * 处理 approval rule matches 相关逻辑。
 *
 * @param {unknown} request - request 参数。
 * @param {unknown} rule - rule 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function approvalRuleMatches(request, rule) {
  if (rule.resource_type && rule.resource_type !== request.resource_type) {
    return false;
  }

  if (rule.action && rule.action !== request.action) {
    return false;
  }

  if (rule.subject && rule.subject !== request.subject) {
    return false;
  }

  if (rule.subjectPrefix && !request.subject.startsWith(rule.subjectPrefix)) {
    return false;
  }

  return true;
}
