import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVAL_ACTIONS,
  APPROVAL_DECISIONS,
  APPROVAL_RESOURCE_TYPES,
  ApprovalGate,
  CAPABILITY_ACTIONS,
  CAPABILITY_DECISIONS,
  CAPABILITY_RESOURCES,
  CAPABILITY_RISKS,
  SandboxPolicy,
  approvalActionForCapability,
  approvalResourceTypeForCapability,
  capabilityRequestToApprovalRequest,
  capabilityRiskFromCommand,
  checkCapability,
  createApplyPatchCapabilityRequest,
  createExecCapabilityRequest,
  createFilesystemWriteCapabilityRequest,
  createMcpToolCapabilityRequest,
  createNetworkCapabilityRequest,
  createProcessSpawnCapabilityRequest
} from "../src/index.js";

test("capability requests map exec operations to approval metadata", () => {
  const capability = createExecCapabilityRequest({
    command: "npm test",
    cwd: "/workspace",
    tool: "shell_command",
    arguments: {
      command: "npm test"
    }
  });
  const approval = capabilityRequestToApprovalRequest(capability);

  assert.equal(capability.resource, CAPABILITY_RESOURCES.EXEC);
  assert.equal(capability.action, CAPABILITY_ACTIONS.EXECUTE);
  assert.equal(capability.risk, CAPABILITY_RISKS.MEDIUM);
  assert.equal(approval.resourceType, APPROVAL_RESOURCE_TYPES.EXEC);
  assert.equal(approval.action, APPROVAL_ACTIONS.EXECUTE);
  assert.equal(approval.subject, "npm test");
  assert.equal(approval.metadata.capability.metadata.tool, "shell_command");
});

test("capability requests map apply_patch writes to approval metadata", () => {
  const capability = createApplyPatchCapabilityRequest({
    patch: "*** Begin Patch\n*** End Patch",
    workingDirectory: "/workspace"
  });
  const approval = capabilityRequestToApprovalRequest(capability);

  assert.equal(capability.resource, CAPABILITY_RESOURCES.FILE);
  assert.equal(capability.action, CAPABILITY_ACTIONS.WRITE);
  assert.equal(capability.risk, CAPABILITY_RISKS.HIGH);
  assert.equal(approval.resourceType, APPROVAL_RESOURCE_TYPES.APPLY_PATCH);
  assert.equal(approval.action, APPROVAL_ACTIONS.WRITE);
  assert.equal(approval.subject, "/workspace");
  assert.equal(approval.metadata.capability.subject, "apply_patch");
  assert.equal(approval.metadata.capability.metadata.workingDirectory, "/workspace");
});

test("capability risk classifies network and destructive commands", () => {
  assert.equal(capabilityRiskFromCommand("npm test"), CAPABILITY_RISKS.MEDIUM);
  assert.equal(capabilityRiskFromCommand("curl https://example.com"), CAPABILITY_RISKS.HIGH);
  assert.equal(capabilityRiskFromCommand("rm -rf dist"), CAPABILITY_RISKS.DESTRUCTIVE);
});

test("capability requests map MCP tools to tool approval metadata", () => {
  const capability = createMcpToolCapabilityRequest({
    name: "mcp__fs__read",
    server: "fs",
    tool: "read",
    arguments: {
      path: "README.md"
    }
  });
  const approval = capabilityRequestToApprovalRequest(capability);

  assert.equal(capability.resource, CAPABILITY_RESOURCES.MCP);
  assert.equal(capability.action, CAPABILITY_ACTIONS.RUN);
  assert.equal(capability.risk, CAPABILITY_RISKS.HIGH);
  assert.equal(approval.resourceType, APPROVAL_RESOURCE_TYPES.TOOL);
  assert.equal(approval.action, APPROVAL_ACTIONS.RUN);
  assert.equal(approval.subject, "mcp__fs__read");
  assert.equal(approval.metadata.capability.metadata.server, "fs");
  assert.equal(approval.metadata.capability.metadata.mcpTool, "read");
});

test("capability requests map hosted network tools to tool approval metadata", () => {
  const capability = createNetworkCapabilityRequest({
    subject: "web_search",
    tool: "web_search",
    kind: "web_search",
    url: "https://hosted.example/tool",
    arguments: {
      query: "codex"
    }
  });
  const approval = capabilityRequestToApprovalRequest(capability);

  assert.equal(capability.resource, CAPABILITY_RESOURCES.NETWORK);
  assert.equal(capability.action, CAPABILITY_ACTIONS.CONNECT);
  assert.equal(capability.risk, CAPABILITY_RISKS.HIGH);
  assert.equal(approval.resourceType, APPROVAL_RESOURCE_TYPES.TOOL);
  assert.equal(approval.action, APPROVAL_ACTIONS.RUN);
  assert.equal(approval.subject, "web_search");
  assert.equal(approval.metadata.capability.metadata.url, "https://hosted.example/tool");
  assert.equal(approval.metadata.capability.metadata.kind, "web_search");
});

test("capability requests map app-server filesystem writes to tool approval metadata", () => {
  const capability = createFilesystemWriteCapabilityRequest({
    method: "fs/writeFile",
    path: "/workspace/file.txt"
  });
  const approval = capabilityRequestToApprovalRequest(capability);

  assert.equal(capability.resource, CAPABILITY_RESOURCES.TOOL);
  assert.equal(capability.action, CAPABILITY_ACTIONS.WRITE);
  assert.equal(capability.risk, CAPABILITY_RISKS.HIGH);
  assert.equal(approval.resourceType, APPROVAL_RESOURCE_TYPES.TOOL);
  assert.equal(approval.action, APPROVAL_ACTIONS.WRITE);
  assert.equal(approval.subject, "fs/writeFile:/workspace/file.txt");
  assert.equal(approval.metadata.capability.metadata.source, "app-server-fs");
});

test("capability requests map app-server process spawn to exec approval metadata", () => {
  const capability = createProcessSpawnCapabilityRequest({
    commandText: "node -e console.log(1)",
    argv: ["node", "-e", "console.log(1)"],
    cwd: "/workspace",
    processHandle: "proc-1"
  });
  const approval = capabilityRequestToApprovalRequest(capability);

  assert.equal(capability.resource, CAPABILITY_RESOURCES.EXEC);
  assert.equal(capability.action, CAPABILITY_ACTIONS.EXECUTE);
  assert.equal(approval.resourceType, APPROVAL_RESOURCE_TYPES.EXEC);
  assert.equal(approval.action, APPROVAL_ACTIONS.EXECUTE);
  assert.equal(approval.subject, "node -e console.log(1)");
  assert.equal(approval.metadata.capability.metadata.processHandle, "proc-1");
  assert.equal(approval.metadata.capability.metadata.source, "app-server-process");
});

test("checkCapability combines sandbox and approval decisions", async () => {
  const allowed = await checkCapability({
    request: createExecCapabilityRequest({
      command: "npm test",
      cwd: "/workspace"
    }),
    approvalGate: new ApprovalGate({
      defaultDecision: APPROVAL_DECISIONS.ALLOW
    }),
    sandboxPolicy: new SandboxPolicy({
      mode: "workspace-write",
      workingDirectory: "/workspace"
    })
  });

  assert.equal(allowed.decision, CAPABILITY_DECISIONS.ALLOW);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.approval.decision, APPROVAL_DECISIONS.ALLOW);
  assert.equal(allowed.sandbox.decision, "allow");

  const prompted = await checkCapability({
    request: createExecCapabilityRequest({
      command: "npm test",
      cwd: "/workspace"
    }),
    approvalGate: new ApprovalGate({
      defaultDecision: APPROVAL_DECISIONS.PROMPT
    })
  });

  assert.equal(prompted.decision, CAPABILITY_DECISIONS.PROMPT);
  assert.equal(prompted.allowed, false);

  const sandboxDenied = await checkCapability({
    request: createExecCapabilityRequest({
      command: "npm test",
      cwd: "/outside"
    }),
    approvalGate: new ApprovalGate({
      defaultDecision: APPROVAL_DECISIONS.ALLOW
    }),
    sandboxPolicy: new SandboxPolicy({
      mode: "workspace-write",
      workingDirectory: "/workspace"
    })
  });

  assert.equal(sandboxDenied.decision, CAPABILITY_DECISIONS.DENY);
  assert.equal(sandboxDenied.allowed, false);
  assert.equal(sandboxDenied.approval, null);
  assert.match(sandboxDenied.reason, /outside sandbox roots/);
});

test("capability approval helpers expose stable enum mapping", () => {
  assert.equal(approvalResourceTypeForCapability(CAPABILITY_RESOURCES.EXEC), APPROVAL_RESOURCE_TYPES.EXEC);
  assert.equal(approvalResourceTypeForCapability(CAPABILITY_RESOURCES.FILE), APPROVAL_RESOURCE_TYPES.APPLY_PATCH);
  assert.equal(approvalResourceTypeForCapability(CAPABILITY_RESOURCES.TOOL), APPROVAL_RESOURCE_TYPES.TOOL);
  assert.equal(approvalActionForCapability(CAPABILITY_ACTIONS.EXECUTE), APPROVAL_ACTIONS.EXECUTE);
  assert.equal(approvalActionForCapability(CAPABILITY_ACTIONS.WRITE), APPROVAL_ACTIONS.WRITE);
  assert.equal(approvalActionForCapability(CAPABILITY_ACTIONS.RUN), APPROVAL_ACTIONS.RUN);
});
