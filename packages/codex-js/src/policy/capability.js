import {
  APPROVAL_ACTIONS,
  APPROVAL_DECISIONS,
  APPROVAL_RESOURCE_TYPES
} from "../approval/policy.js";
import {
  SANDBOX_ACCESS_TYPES,
  SANDBOX_DECISIONS,
  classifyCommandRisk
} from "../sandbox/policy.js";

export const CAPABILITY_RESOURCES = Object.freeze({
  EXEC: "exec",
  FILE: "file",
  TOOL: "tool",
  NETWORK: "network",
  MCP: "mcp"
});

export const CAPABILITY_ACTIONS = Object.freeze({
  READ: "read",
  WRITE: "write",
  EXECUTE: "execute",
  RUN: "run",
  CONNECT: "connect"
});

export const CAPABILITY_RISKS = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  DESTRUCTIVE: "destructive"
});

export const CAPABILITY_DECISIONS = Object.freeze({
  ALLOW: "allow",
  PROMPT: "prompt",
  DENY: "deny"
});

export function createCapabilityRequest(options = {}) {
  const resource = String(options.resource ?? CAPABILITY_RESOURCES.TOOL);
  const action = String(options.action ?? CAPABILITY_ACTIONS.RUN);
  const subject = String(options.subject ?? "");
  const description = options.description == null ? null : String(options.description);
  const risk = normalizeCapabilityRisk(options.risk);
  const metadata = options.metadata ?? {};
  const auditId = String(options.auditId ?? options.audit_id ?? createCapabilityAuditId({
    resource,
    action,
    subject,
    risk,
    metadata
  }));

  return {
    auditId,
    resource,
    action,
    subject,
    description,
    risk,
    metadata
  };
}

export function createExecCapabilityRequest(options = {}) {
  const command = String(options.command ?? "");
  const risk = capabilityRiskFromCommand(command);

  return createCapabilityRequest({
    auditId: options.auditId ?? options.audit_id,
    resource: CAPABILITY_RESOURCES.EXEC,
    action: CAPABILITY_ACTIONS.EXECUTE,
    subject: command,
    description: `Execute command: ${command}`,
    risk,
    metadata: {
      command,
      cwd: options.cwd ?? null,
      tool: options.tool ?? null,
      arguments: options.arguments ?? null,
      env: options.env ?? null
    }
  });
}

export function createApplyPatchCapabilityRequest(options = {}) {
  return createCapabilityRequest({
    auditId: options.auditId ?? options.audit_id,
    resource: CAPABILITY_RESOURCES.FILE,
    action: CAPABILITY_ACTIONS.WRITE,
    subject: "apply_patch",
    description: "Apply patch writes",
    risk: CAPABILITY_RISKS.HIGH,
    metadata: {
      patch: String(options.patch ?? ""),
      workingDirectory: options.workingDirectory ?? null,
      tool: options.tool ?? "apply_patch"
    }
  });
}

export function createToolCapabilityRequest(options = {}) {
  return createCapabilityRequest({
    auditId: options.auditId ?? options.audit_id,
    resource: options.resource ?? CAPABILITY_RESOURCES.TOOL,
    action: options.action ?? CAPABILITY_ACTIONS.RUN,
    subject: options.subject ?? options.tool ?? "",
    description: options.description ?? `Run tool: ${options.subject ?? options.tool ?? ""}`,
    risk: options.risk ?? CAPABILITY_RISKS.MEDIUM,
    metadata: {
      tool: options.tool ?? options.subject ?? null,
      arguments: options.arguments ?? null,
      source: options.source ?? null,
      ...options.metadata
    }
  });
}

export function createMcpToolCapabilityRequest(options = {}) {
  const server = options.server ?? null;
  const tool = options.tool ?? null;
  const name = options.name ?? (server && tool ? `mcp__${server}__${tool}` : tool);

  return createToolCapabilityRequest({
    resource: CAPABILITY_RESOURCES.MCP,
    action: CAPABILITY_ACTIONS.RUN,
    subject: name,
    description: `Run MCP tool: ${name}`,
    risk: CAPABILITY_RISKS.HIGH,
    tool: name,
    arguments: options.arguments,
    source: "mcp",
    metadata: {
      server,
      mcpTool: tool,
      name
    }
  });
}

export function createNetworkCapabilityRequest(options = {}) {
  const subject = String(options.subject ?? options.url ?? options.tool ?? "");

  return createCapabilityRequest({
    auditId: options.auditId ?? options.audit_id,
    resource: CAPABILITY_RESOURCES.NETWORK,
    action: CAPABILITY_ACTIONS.CONNECT,
    subject,
    description: options.description ?? `Connect to hosted tool: ${subject}`,
    risk: options.risk ?? CAPABILITY_RISKS.HIGH,
    metadata: {
      url: options.url ?? null,
      tool: options.tool ?? subject,
      kind: options.kind ?? null,
      arguments: options.arguments ?? null,
      source: options.source ?? "hosted",
      ...options.metadata
    }
  });
}

export function createFilesystemWriteCapabilityRequest(options = {}) {
  const method = String(options.method ?? "");
  const targetPath = String(options.path ?? "");

  return createCapabilityRequest({
    auditId: options.auditId ?? options.audit_id,
    resource: CAPABILITY_RESOURCES.TOOL,
    action: CAPABILITY_ACTIONS.WRITE,
    subject: `${method}:${targetPath}`,
    description: `Filesystem write operation: ${method}`,
    risk: CAPABILITY_RISKS.HIGH,
    metadata: {
      method,
      path: targetPath,
      source: "app-server-fs"
    }
  });
}

export function createProcessSpawnCapabilityRequest(options = {}) {
  const argv = Array.isArray(options.argv ?? options.command)
    ? (options.argv ?? options.command).map(String)
    : [];
  const command = String(options.commandText ?? options.command ?? argv.join(" "));

  return createCapabilityRequest({
    auditId: options.auditId ?? options.audit_id,
    resource: CAPABILITY_RESOURCES.EXEC,
    action: CAPABILITY_ACTIONS.EXECUTE,
    subject: command,
    description: `Spawn process: ${command}`,
    risk: capabilityRiskFromCommand(command),
    metadata: {
      command,
      argv,
      cwd: options.cwd ?? null,
      env: options.env ?? null,
      processHandle: options.processHandle ?? null,
      source: "app-server-process"
    }
  });
}

export function createCommandSessionCapabilityRequest(options = {}) {
  const command = String(options.command ?? "");

  return createCapabilityRequest({
    auditId: options.auditId ?? options.audit_id,
    resource: CAPABILITY_RESOURCES.EXEC,
    action: CAPABILITY_ACTIONS.EXECUTE,
    subject: command,
    description: `Execute command session: ${command}`,
    risk: capabilityRiskFromCommand(command),
    metadata: {
      command,
      argv: options.argv ?? null,
      cwd: options.cwd ?? null,
      env: options.env ?? null,
      processId: options.processId ?? null,
      tty: Boolean(options.tty ?? false),
      streamStdin: Boolean(options.streamStdin ?? false),
      source: "app-server-command-session"
    }
  });
}

export function capabilityRequestToApprovalRequest(request) {
  const capability = createCapabilityRequest(request);
  const resourceType = approvalResourceTypeForCapability(capability.resource);
  const action = approvalActionForCapability(capability.action);

  return {
    resourceType,
    action,
    subject: approvalSubjectForCapability(capability),
    description: capability.description,
    metadata: {
      ...capability.metadata,
      capability
    }
  };
}

export function createCapabilityDecision(options = {}) {
  const decision = options.decision ?? CAPABILITY_DECISIONS.ALLOW;

  return {
    decision,
    allowed: decision === CAPABILITY_DECISIONS.ALLOW,
    request: options.request ? createCapabilityRequest(options.request) : null,
    approval: options.approval ?? null,
    sandbox: options.sandbox ?? null,
    reason: options.reason ?? null
  };
}

export async function checkCapability(options = {}) {
  const request = createCapabilityRequest(options.request ?? options);
  const sandbox = options.sandbox ?? checkCapabilitySandbox(request, options.sandboxPolicy);

  if (sandbox?.decision === SANDBOX_DECISIONS.DENY) {
    return createCapabilityDecision({
      decision: CAPABILITY_DECISIONS.DENY,
      request,
      sandbox,
      reason: sandbox.reason ?? "sandbox denied capability"
    });
  }

  const approval = options.approval ?? await checkCapabilityApproval(request, options.approvalGate);

  if (approval && approval.decision !== APPROVAL_DECISIONS.ALLOW) {
    return createCapabilityDecision({
      decision: approval.decision === APPROVAL_DECISIONS.PROMPT
        ? CAPABILITY_DECISIONS.PROMPT
        : CAPABILITY_DECISIONS.DENY,
      request,
      approval,
      sandbox,
      reason: `approval ${approval.decision}`
    });
  }

  return createCapabilityDecision({
    decision: CAPABILITY_DECISIONS.ALLOW,
    request,
    approval,
    sandbox
  });
}

export async function checkCapabilityApproval(request, approvalGate) {
  if (!approvalGate) {
    return null;
  }

  return await approvalGate.check(capabilityRequestToApprovalRequest(request));
}

export function checkCapabilitySandbox(request, sandboxPolicy) {
  if (!sandboxPolicy) {
    return null;
  }

  const capability = createCapabilityRequest(request);

  if (capability.resource === CAPABILITY_RESOURCES.EXEC) {
    return sandboxPolicy.checkExec({
      command: capability.metadata.command ?? capability.subject,
      cwd: capability.metadata.cwd,
      env: capability.metadata.env
    });
  }

  if (capability.resource === CAPABILITY_RESOURCES.FILE) {
    const accessType = capability.action === CAPABILITY_ACTIONS.WRITE
      ? SANDBOX_ACCESS_TYPES.WRITE
      : SANDBOX_ACCESS_TYPES.READ;
    const targetPath = capability.metadata.path ?? capability.metadata.workingDirectory;

    if (!targetPath) {
      return null;
    }

    return sandboxPolicy.checkPath(targetPath, accessType);
  }

  if (capability.resource === CAPABILITY_RESOURCES.NETWORK) {
    return sandboxPolicy.checkNetwork();
  }

  return null;
}

export function approvalResourceTypeForCapability(resource) {
  switch (resource) {
    case CAPABILITY_RESOURCES.EXEC:
      return APPROVAL_RESOURCE_TYPES.EXEC;
    case CAPABILITY_RESOURCES.FILE:
      return APPROVAL_RESOURCE_TYPES.APPLY_PATCH;
    case CAPABILITY_RESOURCES.TOOL:
    case CAPABILITY_RESOURCES.NETWORK:
    case CAPABILITY_RESOURCES.MCP:
    default:
      return APPROVAL_RESOURCE_TYPES.TOOL;
  }
}

export function approvalActionForCapability(action) {
  switch (action) {
    case CAPABILITY_ACTIONS.EXECUTE:
      return APPROVAL_ACTIONS.EXECUTE;
    case CAPABILITY_ACTIONS.WRITE:
      return APPROVAL_ACTIONS.WRITE;
    case CAPABILITY_ACTIONS.READ:
    case CAPABILITY_ACTIONS.RUN:
    case CAPABILITY_ACTIONS.CONNECT:
    default:
      return APPROVAL_ACTIONS.RUN;
  }
}

export function approvalSubjectForCapability(capability) {
  const request = createCapabilityRequest(capability);

  if (request.resource === CAPABILITY_RESOURCES.FILE && request.metadata.workingDirectory) {
    return String(request.metadata.workingDirectory);
  }

  return request.subject;
}

export function capabilityRiskFromCommand(command) {
  const risk = classifyCommandRisk(command);

  if (risk === "destructive") {
    return CAPABILITY_RISKS.DESTRUCTIVE;
  }

  if (risk === "network") {
    return CAPABILITY_RISKS.HIGH;
  }

  return CAPABILITY_RISKS.MEDIUM;
}

export function normalizeCapabilityRisk(value) {
  const risk = String(value ?? CAPABILITY_RISKS.MEDIUM);

  return Object.values(CAPABILITY_RISKS).includes(risk)
    ? risk
    : CAPABILITY_RISKS.MEDIUM;
}

export function createCapabilityAuditId(options = {}) {
  return `cap_${stableHash(stableStringify({
    resource: options.resource ?? CAPABILITY_RESOURCES.TOOL,
    action: options.action ?? CAPABILITY_ACTIONS.RUN,
    subject: options.subject ?? "",
    risk: options.risk ?? CAPABILITY_RISKS.MEDIUM,
    metadata: options.metadata ?? {}
  }))}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return `{${entries.map(([key, entryValue]) =>
    `${JSON.stringify(key)}:${stableStringify(entryValue)}`
  ).join(",")}}`;
}

function stableHash(text) {
  let hash = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36).padStart(7, "0");
}
