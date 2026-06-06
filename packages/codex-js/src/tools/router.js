import { ApprovalGate, APPROVAL_DECISIONS } from "../approval/policy.js";
import {
  SANDBOX_DECISIONS
} from "../sandbox/policy.js";
import { ToolRegistry } from "./registry.js";
import {
  TOOL_CALL_RESULT_STATUSES,
  createToolCallRequest,
  createToolCallResult
} from "./runtime.js";
import { createToolApprovalGateRequest } from "./handlers.js";

export class ToolRouter {
  constructor(options = {}) {
    this.registry = options.registry ?? new ToolRegistry({
      tools: options.tools ?? []
    });
    this.approvalGate = options.approvalGate ?? null;
    this.sandboxPolicy = options.sandboxPolicy ?? null;
  }

  has(name) {
    return this.registry.has(name);
  }

  get(name) {
    return this.registry.get(name);
  }

  list() {
    return this.registry.list();
  }

  modelVisibleSpecs() {
    return this.registry.modelVisibleSpecs();
  }

  register(tool) {
    return this.registry.register(tool);
  }

  async loadToolDefinitions(definitions = []) {
    const loaded = [];

    for (const definition of definitions) {
      if (this.registry.has(definition.name ?? definition.spec?.name)) {
        this.registry.unregister(definition.name ?? definition.spec?.name);
      }

      loaded.push(this.registry.register(definition));
    }

    return loaded;
  }

  async loadMcpRuntime(mcpRuntime, options = {}) {
    const definitions = await mcpRuntime.discoverTools(options);

    return await this.loadToolDefinitions(definitions);
  }

  async run(toolCall, context = {}) {
    const request = createToolCallRequest(toolCall);
    const entry = this.registry.get(request.name);

    if (!entry?.handler) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: `tool execution is not implemented: ${request.name}`,
        error: "not_implemented"
      });
    }

    const approval = await this.checkApproval(entry, request, context);

    if (approval && approval.decision !== APPROVAL_DECISIONS.ALLOW) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: `tool blocked: ${approval.decision}`,
        error: `blocked: ${approval.decision}`,
        raw: {
          approval
        }
      });
    }

    const sandbox = this.checkSandbox(entry, request, context);

    if (sandbox && sandbox.decision !== SANDBOX_DECISIONS.ALLOW) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: `tool sandbox blocked: ${sandbox.reason}`,
        error: "sandbox_denied",
        raw: {
          sandbox
        }
      });
    }

    return await entry.handler.run(request, {
      ...context,
      router: this,
      approvalGate: context.approvalGate ?? this.approvalGate,
      sandboxPolicy: context.sandboxPolicy ?? this.sandboxPolicy
    });
  }

  async checkApproval(entry, request, context = {}) {
    if (entry.metadata?.approvalHandledBy === "handler") {
      return null;
    }

    if (!entry.metadata?.requiresApproval) {
      return null;
    }

    const approvalGate = context.approvalGate ?? this.approvalGate;

    if (!approvalGate) {
      return null;
    }

    return await approvalGate.check(createToolApprovalGateRequest(request.name, {
      metadata: {
        arguments: request.arguments
      }
    }));
  }

  checkSandbox(entry, request, context = {}) {
    if (entry.metadata?.sandboxHandledBy === "handler") {
      return null;
    }

    if (!entry.metadata?.requiresSandbox) {
      return null;
    }

    const sandboxPolicy = context.sandboxPolicy ?? this.sandboxPolicy;

    if (!sandboxPolicy) {
      return null;
    }

    if (typeof entry.metadata.checkSandbox === "function") {
      return entry.metadata.checkSandbox(request, sandboxPolicy);
    }

    return null;
  }
}

export function createToolRouter(options = {}) {
  return new ToolRouter(options);
}
