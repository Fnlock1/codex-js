import { randomUUID } from "node:crypto";
import {
  APPROVAL_REVIEW_DECISIONS
} from "../approval/policy.js";
import {
  createPermissionsApprovalParams,
  createPermissionsResponseFromClientResult,
  permissionProfileIsEmpty
} from "./permissions.js";
import {
  createRpcRequest
} from "./protocol.js";

export const APP_SERVER_REQUEST_METHODS = Object.freeze({
  COMMAND_EXECUTION_REQUEST_APPROVAL: "item/commandExecution/requestApproval",
  FILE_CHANGE_REQUEST_APPROVAL: "item/fileChange/requestApproval",
  PERMISSIONS_REQUEST_APPROVAL: "item/permissions/requestApproval",
  TOOL_REQUEST_USER_INPUT: "item/tool/requestUserInput"
});

export const SERVER_REQUEST_KINDS = Object.freeze({
  COMMAND_EXECUTION_APPROVAL: "command_execution_approval",
  FILE_CHANGE_APPROVAL: "file_change_approval",
  PERMISSIONS_APPROVAL: "permissions_approval",
  TOOL_USER_INPUT: "tool_user_input"
});

export class ServerRequestStore {
  constructor(options = {}) {
    this.pending = new Map();
    this.onRequest = options.onRequest ?? null;
    this.onResolved = options.onResolved ?? null;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  create(options = {}) {
    const requestId = options.requestId ?? this.idFactory();
    const pending = {
      requestId,
      kind: options.kind ?? "server_request",
      method: String(options.method ?? ""),
      params: options.params ?? {},
      approval: options.approval ?? null,
      threadId: options.threadId ?? options.params?.threadId ?? null,
      turnId: options.turnId ?? options.params?.turnId ?? null,
      itemId: options.itemId ?? options.params?.itemId ?? null,
      createdAtMs: options.createdAtMs ?? Date.now(),
      metadata: options.metadata ?? {}
    };

    pending.envelope = createRpcRequest(pending.method, pending.params, requestId);
    this.pending.set(requestId, pending);

    if (this.onRequest) {
      this.onRequest(pending);
    }

    return pending;
  }

  list(options = {}) {
    const threadId = options.threadId ?? null;
    const requests = [...this.pending.values()]
      .filter((request) => !threadId || request.threadId === threadId)
      .map((request) => createServerRequestView(request));

    return {
      requests
    };
  }

  get(requestId) {
    return this.pending.get(String(requestId));
  }

  resolve(requestId, response = {}) {
    const key = String(requestId);
    const pending = this.pending.get(key);

    if (!pending) {
      return null;
    }

    this.pending.delete(key);
    const resolved = {
      requestId: key,
      threadId: pending.threadId,
      turnId: pending.turnId,
      itemId: pending.itemId,
      kind: pending.kind,
      response,
      resolvedAtMs: Date.now()
    };

    if (this.onResolved) {
      this.onResolved(resolved, pending);
    }

    return {
      pending,
      resolved
    };
  }

  clear(options = {}) {
    const threadId = options.threadId ?? null;
    const cleared = [];

    for (const request of [...this.pending.values()]) {
      if (threadId && request.threadId !== threadId) {
        continue;
      }

      const result = this.resolve(request.requestId, {
        decision: options.decision ?? "cancel",
        reason: options.reason ?? "cleared"
      });

      if (result) {
        cleared.push(result.resolved);
      }
    }

    return cleared;
  }
}

export function createCommandExecutionApprovalServerRequest(options = {}) {
  const approval = options.approval ?? {};
  const request = approval.approvalRequest ?? approval.request ?? {};
  const metadata = request.request?.metadata ?? request.metadata ?? {};
  const command = options.command ?? metadata.command ?? request.subject ?? null;
  const cwd = options.cwd ?? metadata.cwd ?? null;
  const threadId = String(options.threadId ?? metadata.threadId ?? "standalone");
  const turnId = String(options.turnId ?? metadata.turnId ?? "standalone");
  const itemId = String(options.itemId ?? metadata.itemId ?? request.call_id ?? request.id ?? randomUUID());

  return {
    kind: SERVER_REQUEST_KINDS.COMMAND_EXECUTION_APPROVAL,
    method: APP_SERVER_REQUEST_METHODS.COMMAND_EXECUTION_REQUEST_APPROVAL,
    threadId,
    turnId,
    itemId,
    approval,
    params: omitNullish({
      threadId,
      turnId,
      itemId,
      startedAtMs: Date.now(),
      approvalId: options.approvalId ?? null,
      reason: options.reason ?? request.description ?? "Command execution requires approval.",
      command: command == null ? null : String(command),
      cwd: cwd == null ? null : String(cwd),
      commandActions: options.commandActions ?? null,
      proposedExecpolicyAmendment: options.proposedExecpolicyAmendment ?? null,
      proposedNetworkPolicyAmendments: options.proposedNetworkPolicyAmendments ?? null,
      availableDecisions: options.availableDecisions ?? [
        "accept",
        "acceptForSession",
        "decline",
        "cancel"
      ]
    })
  };
}

export function createFileChangeApprovalServerRequest(options = {}) {
  const approval = options.approval ?? {};
  const request = approval.approvalRequest ?? approval.request ?? {};
  const metadata = request.request?.metadata ?? request.metadata ?? {};
  const path = options.path ?? metadata.path ?? request.subject ?? null;
  const threadId = String(options.threadId ?? metadata.threadId ?? "standalone");
  const turnId = String(options.turnId ?? metadata.turnId ?? "standalone");
  const itemId = String(options.itemId ?? metadata.itemId ?? request.call_id ?? request.id ?? randomUUID());

  return {
    kind: SERVER_REQUEST_KINDS.FILE_CHANGE_APPROVAL,
    method: APP_SERVER_REQUEST_METHODS.FILE_CHANGE_REQUEST_APPROVAL,
    threadId,
    turnId,
    itemId,
    approval,
    params: omitNullish({
      threadId,
      turnId,
      itemId,
      startedAtMs: Date.now(),
      reason: options.reason ?? request.description ?? "File change requires approval.",
      grantRoot: options.grantRoot ?? path ?? null,
      availableDecisions: options.availableDecisions ?? [
        "accept",
        "acceptForSession",
        "decline",
        "cancel"
      ]
    })
  };
}

export function createPermissionsApprovalServerRequest(options = {}) {
  const approval = options.approval ?? null;
  const metadata = approval?.approvalRequest?.request?.metadata ?? approval?.request?.metadata ?? {};
  const params = createPermissionsApprovalParams({
    threadId: options.threadId ?? metadata.threadId,
    turnId: options.turnId ?? metadata.turnId,
    itemId: options.itemId ?? options.callId ?? metadata.itemId ?? metadata.callId,
    environmentId: options.environmentId ?? options.environment_id ?? metadata.environmentId ?? metadata.environment_id,
    cwd: options.cwd ?? metadata.cwd,
    reason: options.reason ?? metadata.reason,
    permissions: options.permissions ?? metadata.permissions
  });

  return {
    kind: SERVER_REQUEST_KINDS.PERMISSIONS_APPROVAL,
    method: APP_SERVER_REQUEST_METHODS.PERMISSIONS_REQUEST_APPROVAL,
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    approval,
    params
  };
}

export function createServerRequestView(request) {
  return {
    requestId: request.requestId,
    kind: request.kind,
    method: request.method,
    params: request.params,
    threadId: request.threadId,
    turnId: request.turnId,
    itemId: request.itemId,
    createdAtMs: request.createdAtMs
  };
}

export function approvalReviewDecisionFromServerResponse(response = {}) {
  const decision = response.decision ?? response.result?.decision ?? response;

  if (response.result?.permissions || response.permissions) {
    return permissionProfileIsEmpty(response.result?.permissions ?? response.permissions)
      ? APPROVAL_REVIEW_DECISIONS.DENIED
      : response.result?.scope === "session" || response.scope === "session"
        ? APPROVAL_REVIEW_DECISIONS.APPROVED_FOR_SESSION
        : APPROVAL_REVIEW_DECISIONS.APPROVED;
  }

  if (decision === "acceptForSession") {
    return APPROVAL_REVIEW_DECISIONS.APPROVED_FOR_SESSION;
  }

  if (
    decision === "accept" ||
    (decision && typeof decision === "object" && (
      decision.acceptWithExecpolicyAmendment ||
      decision.applyNetworkPolicyAmendment
    ))
  ) {
    return APPROVAL_REVIEW_DECISIONS.APPROVED;
  }

  if (decision === "cancel") {
    return APPROVAL_REVIEW_DECISIONS.ABORT;
  }

  return APPROVAL_REVIEW_DECISIONS.DENIED;
}

export function permissionsResponseFromServerResponse(pending, response = {}) {
  return createPermissionsResponseFromClientResult({
    requested: pending.params?.permissions ?? {},
    response,
    cwd: pending.params?.cwd
  });
}

function omitNullish(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  );
}
