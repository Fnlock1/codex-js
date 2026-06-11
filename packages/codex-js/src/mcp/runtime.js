/**
 * 中文模块说明：src/mcp/runtime.js
 *
 * MCP 客户端、stdio 连接、协议转换和运行时封装。
 */
import { APPROVAL_DECISIONS } from "../approval/policy.js";
import {
  TOOL_CALL_RESULT_STATUSES,
  createToolCallResult
} from "../tools/runtime.js";
import {
  checkCapabilityApproval,
  createCapabilityDecision,
  createMcpToolCapabilityRequest
} from "../policy/capability.js";
import { NotConnectedMcpClient } from "./client.js";
import {
  createMcpToolSpec,
  mcpCallToolResultToText,
  parseMcpToolName
} from "./protocol.js";

/**
 * 定义 McpRuntime 类，封装当前模块的状态和行为。
 */
export class McpRuntime {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.client = options.client ?? new NotConnectedMcpClient();
    this.approvalGate = options.approvalGate ?? null;
  }

  /**
   * 列出 list servers 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
  async listServers() {
    return await this.client.listServers();
  }

  /**
   * 列出 list tools 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} serverName - serverName 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async listTools(serverName) {
    return await this.client.listTools(serverName);
  }

  /**
   * 列出 list server statuses 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
  async listServerStatuses() {
    if (typeof this.client.listServerStatuses !== "function") {
      return (await this.listServers()).map((server) => ({
        name: server.name,
        title: server.title,
        version: server.version,
        status: "unknown",
        error: null,
        disabled: false
      }));
    }

    return await this.client.listServerStatuses();
  }

  /**
   * 处理 refresh 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
  async refresh() {
    if (typeof this.client.refreshAll !== "function") {
      return [];
    }

    return await this.client.refreshAll();
  }

  /**
   * 处理 discover tools 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async discoverTools(options = {}) {
    if (options.refresh ?? true) {
      await this.refresh();
    }

    return await this.createToolDefinitions();
  }

  /**
   * 创建 create tool definitions 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
  async createToolDefinitions() {
    const definitions = [];
    const servers = await this.listServers();

    for (const server of servers) {
      const tools = await this.listTools(server.name);

      for (const tool of tools) {
        const spec = createMcpToolSpec({
          server: server.name,
          tool,
          namespaceDescription: server.description
        });

        definitions.push({
          name: spec.name,
          spec,
          metadata: {
            category: "mcp",
            mcpServer: server.name,
            mcpTool: tool.name,
            requiresApproval: true,
            approvalHandledBy: "handler"
          },
          handler: new McpToolHandler({
            runtime: this,
            server: server.name,
            tool: tool.name
          })
        });
      }
    }

    return definitions;
  }

  /**
   * 处理 call tool 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async callTool(request = {}) {
    const capabilityRequest = createMcpToolCapabilityRequest({
      name: request.name,
      server: request.server,
      tool: request.tool,
      arguments: request.arguments
    });
    const approval = await this.checkApproval(request, capabilityRequest);

    if (approval && approval.decision !== APPROVAL_DECISIONS.ALLOW) {
      const capability = createCapabilityDecision({
        decision: capabilityDecisionFromApproval(approval),
        request: capabilityRequest,
        approval
      });

      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: `mcp tool blocked: ${approval.decision}`,
        error: `blocked: ${approval.decision}`,
        raw: {
          capability,
          approval,
          mcp: {
            server: request.server,
            tool: request.tool
          }
        }
      });
    }

    try {
      const result = await this.client.callTool({
        server: request.server,
        tool: request.tool,
        arguments: request.arguments
      });

      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: result.is_error
          ? TOOL_CALL_RESULT_STATUSES.FAILED
          : TOOL_CALL_RESULT_STATUSES.COMPLETED,
        output: mcpCallToolResultToText(result),
        error: result.is_error ? "mcp_tool_error" : null,
        raw: {
          capability: createCapabilityDecision({
            request: capabilityRequest,
            decision: "allow"
          }),
          mcp: {
            server: request.server,
            tool: request.tool,
            result
          }
        }
      });
    } catch (error) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: error.message,
        error: error.code ?? "mcp_error",
        raw: {
          capability: createCapabilityDecision({
            request: capabilityRequest,
            decision: "allow"
          }),
          mcp: {
            server: request.server,
            tool: request.tool
          }
        }
      });
    }
  }

  /**
   * 列出 list resources 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async listResources(request = {}) {
    return await this.client.listResources(request);
  }

  /**
   * 列出 list resource templates 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async listResourceTemplates(request = {}) {
    return await this.client.listResourceTemplates(request);
  }

  /**
   * 读取 read resource 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async readResource(request = {}) {
    return await this.client.readResource(request);
  }

  /**
   * 处理 check approval 相关逻辑。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async checkApproval(request = {}, capabilityRequest = null) {
    if (!this.approvalGate) {
      return null;
    }

    return await checkCapabilityApproval(capabilityRequest ?? createMcpToolCapabilityRequest({
      name: request.name,
      server: request.server,
      tool: request.tool,
      arguments: request.arguments
    }), this.approvalGate);
  }
}

/**
 * 定义 McpToolHandler 类，封装当前模块的状态和行为。
 */
export class McpToolHandler {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.runtime = options.runtime ?? new McpRuntime();
    this.server = options.server ?? null;
    this.tool = options.tool ?? null;
  }

  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async run(request) {
    const parsed = parseMcpToolName(request.name);

    return await this.runtime.callTool({
      call_id: request.call_id,
      name: request.name,
      server: this.server ?? parsed?.server,
      tool: this.tool ?? parsed?.tool,
      arguments: request.arguments
    });
  }
}

/**
 * 创建 create mcp runtime 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createMcpRuntime(options = {}) {
  return new McpRuntime(options);
}

function capabilityDecisionFromApproval(approval) {
  if (approval?.decision === APPROVAL_DECISIONS.ALLOW) {
    return "allow";
  }

  if (approval?.decision === APPROVAL_DECISIONS.PROMPT) {
    return "prompt";
  }

  return "deny";
}
