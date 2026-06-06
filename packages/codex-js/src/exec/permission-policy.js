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

export class ExecPermissionPolicy {
  constructor(options = {}) {
    this.prefixRules = normalizePrefixRules(options.prefixRules ?? []);
    this.defaultDecision = options.defaultDecision ?? EXEC_POLICY_DECISIONS.PROMPT;
    this.approvalGate = options.approvalGate ?? null;
  }

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

  static allowPrefixes(prefixes) {
    return new ExecPermissionPolicy({
      prefixRules: prefixes.map((prefix) => ({
        prefix,
        decision: EXEC_POLICY_DECISIONS.ALLOW
      }))
    });
  }
}

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

export function tokenizeCommand(command) {
  return String(command ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizePrefixRules(rules) {
  return rules.map((rule) => ({
    prefix: Array.isArray(rule.prefix)
      ? rule.prefix.map(String)
      : tokenizeCommand(rule.prefix),
    decision: rule.decision ?? EXEC_POLICY_DECISIONS.ALLOW,
    justification: rule.justification
  }));
}

function firstMatchingRule(tokens, rules) {
  return rules.find((rule) => prefixMatches(tokens, rule.prefix));
}

function prefixMatches(tokens, prefix) {
  if (prefix.length === 0 || prefix.length > tokens.length) {
    return false;
  }

  return prefix.every((token, index) => token === tokens[index]);
}
