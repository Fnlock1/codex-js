import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXEC_POLICY_DECISIONS,
  APPROVAL_ACTIONS,
  APPROVAL_DECISIONS,
  APPROVAL_RESOURCE_TYPES,
  APPROVAL_REVIEW_DECISIONS,
  ApprovalGate,
  ApprovalPolicy,
  ExecPermissionPolicy,
  REVIEW_DECISIONS,
  approvalSessionKey,
  createApprovalRequest,
  createExecApprovalGateRequest,
  createExecApprovalRequest,
  tokenizeCommand
} from "../src/index.js";

test("tokenizeCommand splits simple shell commands", () => {
  assert.deepEqual(tokenizeCommand("npm test -- --runInBand"), [
    "npm",
    "test",
    "--",
    "--runInBand"
  ]);
});

test("ExecPermissionPolicy defaults to prompt", () => {
  const policy = new ExecPermissionPolicy();
  const result = policy.check("npm test");

  assert.equal(result.decision, EXEC_POLICY_DECISIONS.PROMPT);
  assert.equal(result.approvalRequest.command, "npm test");
  assert.deepEqual(result.approvalRequest.parsed_cmd, ["npm", "test"]);
});

test("ExecPermissionPolicy matches allow and forbidden prefix rules", () => {
  const policy = new ExecPermissionPolicy({
    prefixRules: [
      {
        prefix: ["npm", "test"],
        decision: EXEC_POLICY_DECISIONS.ALLOW
      },
      {
        prefix: ["Remove-Item"],
        decision: EXEC_POLICY_DECISIONS.FORBIDDEN
      }
    ]
  });

  assert.equal(policy.check("npm test").decision, EXEC_POLICY_DECISIONS.ALLOW);
  assert.equal(policy.check("Remove-Item -Recurse .").decision, EXEC_POLICY_DECISIONS.FORBIDDEN);
});

test("createExecApprovalRequest includes amendment and review choices", () => {
  const request = createExecApprovalRequest({
    command: "npm test",
    cwd: "/workspace"
  });

  assert.equal(request.type, "exec_approval_request");
  assert.equal(request.command, "npm test");
  assert.deepEqual(request.proposed_execpolicy_amendment, {
    command: ["npm", "test"]
  });
  assert.deepEqual(request.available_decisions, [
    REVIEW_DECISIONS.APPROVED,
    REVIEW_DECISIONS.APPROVED_FOR_SESSION,
    REVIEW_DECISIONS.ABORT
  ]);
});

test("ApprovalPolicy matches rules and creates approval requests", () => {
  const policy = new ApprovalPolicy({
    rules: [
      {
        resourceType: APPROVAL_RESOURCE_TYPES.EXEC,
        action: APPROVAL_ACTIONS.EXECUTE,
        subjectPrefix: "npm test",
        decision: APPROVAL_DECISIONS.ALLOW
      }
    ]
  });

  assert.equal(policy.check({
    resourceType: "exec",
    action: "execute",
    subject: "npm test -- --runInBand"
  }).decision, APPROVAL_DECISIONS.ALLOW);

  const prompt = policy.check({
    resourceType: "apply_patch",
    action: "write",
    subject: "/workspace"
  });

  assert.equal(prompt.decision, APPROVAL_DECISIONS.PROMPT);
  assert.equal(prompt.approvalRequest.type, "apply_patch_approval_request");
  assert.equal(prompt.approvalRequest.request.resource_type, "apply_patch");
});

test("ApprovalPolicy supports approve for session", () => {
  const policy = new ApprovalPolicy();
  const request = {
    resourceType: "exec",
    action: "execute",
    subject: "npm test"
  };
  const approvalRequest = createApprovalRequest({
    request
  });
  const review = policy.review(approvalRequest, APPROVAL_REVIEW_DECISIONS.APPROVED_FOR_SESSION);

  assert.equal(review.decision, APPROVAL_DECISIONS.ALLOW);
  assert.equal(policy.check(request).decision, APPROVAL_DECISIONS.ALLOW);
  assert.equal(policy.sessionApprovals.has(approvalSessionKey(request)), true);
});

test("ApprovalGate delegates policy checks", () => {
  const gate = new ApprovalGate({
    defaultDecision: APPROVAL_DECISIONS.FORBIDDEN
  });

  assert.equal(gate.check({
    resourceType: "tool",
    action: "run",
    subject: "web_search"
  }).decision, APPROVAL_DECISIONS.FORBIDDEN);
});

test("ExecPermissionPolicy can use ApprovalGate", () => {
  const gate = new ApprovalGate({
    policy: new ApprovalPolicy({
      rules: [
        {
          resourceType: "exec",
          action: "execute",
          subject: "npm test",
          decision: APPROVAL_DECISIONS.ALLOW
        }
      ]
    })
  });
  const policy = new ExecPermissionPolicy({
    approvalGate: gate
  });

  assert.equal(policy.check("npm test").decision, EXEC_POLICY_DECISIONS.ALLOW);
  const prompt = policy.check("npm run build");
  assert.equal(prompt.decision, EXEC_POLICY_DECISIONS.PROMPT);
  assert.equal(prompt.approvalRequest.approval.resource_type, "exec");
});

test("createExecApprovalGateRequest maps exec request metadata", () => {
  const request = createExecApprovalGateRequest({
    command: "npm test",
    cwd: "/workspace"
  });

  assert.equal(request.resourceType, "exec");
  assert.equal(request.action, "execute");
  assert.equal(request.subject, "npm test");
  assert.equal(request.metadata.cwd, "/workspace");
});
