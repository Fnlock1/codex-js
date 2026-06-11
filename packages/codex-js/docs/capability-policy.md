# Capability Policy

`codex-js` uses a capability layer to describe high-risk runtime actions before they reach approval, sandbox, or execution code.

The capability layer is intentionally internal to the standalone `codex-js` runtime. It must not be imported by Qoder Open Desktop or `@qoder-open/shared`.

## Request Shape

A capability request has this stable shape:

```js
{
  auditId: "cap_...",
  resource: "exec" | "file" | "tool" | "network" | "mcp",
  action: "read" | "write" | "execute" | "run" | "connect",
  subject: "string",
  description: "string or null",
  risk: "low" | "medium" | "high" | "destructive",
  metadata: {}
}
```

`auditId` is deterministic by default. It is derived from the resource, action, subject, risk, and metadata so logs, approval requests, server requests, and tool results can be correlated. Callers may pass an explicit `auditId` when they already have a trace identifier.

## Resources

| Resource | Meaning | Approval Mapping |
| --- | --- | --- |
| `exec` | Shell commands, Git commands, app-server command sessions, and process spawn. | `exec` |
| `file` | Direct file writes such as `apply_patch`. | `apply_patch` |
| `tool` | Generic local tool actions and compatibility paths. | `tool` |
| `network` | Hosted provider calls or other network access. | `tool` |
| `mcp` | MCP tool calls. | `tool` |

## Current Entry Points

| Entry Point | Helper | Resource | Notes |
| --- | --- | --- | --- |
| Shell command tool | `createExecCapabilityRequest` | `exec` | Real execution is approval-gated. |
| Git status/diff tools | `createExecCapabilityRequest` | `exec` | Git is modeled as command execution. |
| `apply_patch` writes | `createApplyPatchCapabilityRequest` | `file` | Maps to legacy `apply_patch` approval. |
| MCP tool call | `createMcpToolCapabilityRequest` | `mcp` | Includes server and MCP tool metadata. |
| Hosted provider | `createNetworkCapabilityRequest` | `network` | Approval-gated when an approval gate is present. |
| App-server filesystem write | `createFilesystemWriteCapabilityRequest` | `tool` | Kept as `tool` for protocol compatibility. |
| App-server `process/spawn` | `createProcessSpawnCapabilityRequest` | `exec` | Checked before spawning the process runtime. |
| App-server command session | `createCommandSessionCapabilityRequest` | `exec` | Checked before starting command sessions. |

## Approval Mapping

`capabilityRequestToApprovalRequest()` converts a capability into an approval request.

Important compatibility rules:

- `exec` capabilities map to `APPROVAL_RESOURCE_TYPES.EXEC`.
- `file` capabilities map to `APPROVAL_RESOURCE_TYPES.APPLY_PATCH`.
- `tool`, `network`, and `mcp` capabilities map to `APPROVAL_RESOURCE_TYPES.TOOL`.
- `file` capabilities with `metadata.workingDirectory` use that directory as the approval subject to preserve existing `apply_patch` approval behavior.

The original capability is embedded under `approval.metadata.capability` after normalization. For prompt approvals, the generated approval request contains the normalized request under `approval.approvalRequest.request`.

## Sandbox Mapping

`checkCapabilitySandbox()` currently maps:

- `exec` to `sandboxPolicy.checkExec(...)`.
- `file` reads/writes to `sandboxPolicy.checkPath(...)`.
- `network` to `sandboxPolicy.checkNetwork()`.

Other resources do not have a sandbox mapping yet and rely on approval or entry-point-specific checks.

## Tool Results and Errors

High-risk paths should include capability information in their result metadata:

```js
{
  raw: {
    capability: {
      decision: "allow" | "prompt" | "deny",
      allowed: true,
      request,
      approval,
      sandbox,
      reason
    }
  }
}
```

App-server protocol errors should include `error.data.capability` when a capability check blocks the request.

## Validation

Relevant tests:

```bash
node --test test/capability-policy.test.js
node --test test/app-server.test.js test/tools.test.js test/mcp.test.js
node --test test/e2e-agent-turn.test.js
```
