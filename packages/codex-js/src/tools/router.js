/**
 * 中文模块说明：src/tools/router.js
 *
 * 工具定义、路由、handler、内置工具和上游工具格式转换。
 */
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

/**
 * 定义 ToolRouter 类，封装当前模块的状态和行为。
 */
export class ToolRouter {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.registry = options.registry ?? new ToolRegistry({
      tools: options.tools ?? []
    });
    this.approvalGate = options.approvalGate ?? null;
    this.sandboxPolicy = options.sandboxPolicy ?? null;
  }

  /**
   * 判断是否存在 has 相关数据。
   *
   * @param {unknown} name - name 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  has(name) {
    return this.registry.has(name);
  }

  /**
   * 获取 get 相关数据。
   *
   * @param {unknown} name - name 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  get(name) {
    return this.registry.get(name);
  }

  /**
   * 列出 list 相关数据。
   * @returns {unknown} 返回处理后的结果。
   */
  list() {
    return this.registry.list();
  }

  /**
   * 处理 model visible specs 相关逻辑。
   * @returns {unknown} 返回处理后的结果。
   */
  modelVisibleSpecs(options = {}) {
    return this.registry.modelVisibleSpecs(options);
  }

  /**
   * 处理 register 相关逻辑。
   *
   * @param {unknown} tool - tool 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  register(tool) {
    return this.registry.register(tool);
  }

  /**
   * 加载 load tool definitions 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} definitions - definitions 参数。
   * @returns {unknown} 返回处理后的结果。
   */
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

  /**
   * 加载 load mcp runtime 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} mcpRuntime - mcpRuntime 参数。
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async loadMcpRuntime(mcpRuntime, options = {}) {
    const definitions = await mcpRuntime.discoverTools(options);

    return await this.loadToolDefinitions(definitions);
  }

  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} toolCall - toolCall 参数。
   * @param {unknown} context - context 参数。
   * @returns {unknown} 返回处理后的结果。
   */
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

  /**
   * 处理 check approval 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} entry - entry 参数。
   * @param {unknown} request - request 参数。
   * @param {unknown} context - context 参数。
   * @returns {unknown} 返回处理后的结果。
   */
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

  /**
   * 处理 check sandbox 相关逻辑。
   *
   * @param {unknown} entry - entry 参数。
   * @param {unknown} request - request 参数。
   * @param {unknown} context - context 参数。
   * @returns {unknown} 返回处理后的结果。
   */
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

/**
 * 创建 create tool router 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createToolRouter(options = {}) {
  return new ToolRouter(options);
}
