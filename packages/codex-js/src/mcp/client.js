/**
 * 中文模块说明：src/mcp/client.js
 *
 * MCP 客户端、stdio 连接、协议转换和运行时封装。
 */
import {
  MCP_ERRORS,
  createMcpCallToolResult,
  normalizeMcpResource,
  normalizeMcpResourceContent,
  normalizeMcpResourceTemplate,
  normalizeMcpServerInfo,
  normalizeMcpTool
} from "./protocol.js";

/**
 * 定义 McpClient 类，封装当前模块的状态和行为。
 */
export class McpClient {
  /**
   * 列出 list servers 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
  async listServers() {
    throw createMcpClientError(MCP_ERRORS.NOT_CONNECTED, "MCP client is not connected.");
  }

  /**
   * 列出 list tools 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} _serverName - _serverName 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async listTools(_serverName) {
    throw createMcpClientError(MCP_ERRORS.NOT_CONNECTED, "MCP client is not connected.");
  }

  /**
   * 处理 call tool 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} _request - _request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async callTool(_request) {
    throw createMcpClientError(MCP_ERRORS.NOT_CONNECTED, "MCP client is not connected.");
  }

  /**
   * 列出 list resources 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} _request - _request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async listResources(_request = {}) {
    throw createMcpClientError(MCP_ERRORS.NOT_CONNECTED, "MCP client is not connected.");
  }

  /**
   * 列出 list resource templates 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} _request - _request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async listResourceTemplates(_request = {}) {
    throw createMcpClientError(MCP_ERRORS.NOT_CONNECTED, "MCP client is not connected.");
  }

  /**
   * 读取 read resource 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} _request - _request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async readResource(_request = {}) {
    throw createMcpClientError(MCP_ERRORS.NOT_CONNECTED, "MCP client is not connected.");
  }
}

/**
 * 定义 NotConnectedMcpClient 类，封装当前模块的状态和行为。
 */
export class NotConnectedMcpClient extends McpClient {}

/**
 * 定义 StaticMcpClient 类，封装当前模块的状态和行为。
 */
export class StaticMcpClient extends McpClient {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    super();
    this.servers = new Map();

    for (const server of options.servers ?? []) {
      const info = normalizeMcpServerInfo(server.info ?? server);
      this.servers.set(info.name, {
        info,
        tools: (server.tools ?? []).map(normalizeMcpTool),
        resources: (server.resources ?? []).map(normalizeMcpResource),
        resourceTemplates: (server.resourceTemplates ?? server.resource_templates ?? [])
          .map(normalizeMcpResourceTemplate),
        resourceContents: new Map(Object.entries(server.resourceContents ?? server.resource_contents ?? {})),
        toolResults: new Map(Object.entries(server.toolResults ?? server.tool_results ?? {}))
      });
    }
  }

  /**
   * 列出 list servers 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
  async listServers() {
    return Array.from(this.servers.values()).map((server) => server.info);
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
    const server = this.getServer(serverName);

    return server.tools;
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
    const server = this.getServer(request.server);
    const toolName = String(request.tool ?? "");
    const result = server.toolResults.get(toolName);

    if (!result) {
      throw createMcpClientError(
        MCP_ERRORS.TOOL_NOT_FOUND,
        `MCP tool not found: ${request.server}/${toolName}`
      );
    }

    return createMcpCallToolResult(typeof result === "function"
      ? await result(request)
      : result);
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
    if (request.server) {
      const server = this.getServer(request.server);

      return {
        server: request.server,
        resources: server.resources,
        next_cursor: null
      };
    }

    return {
      server: null,
      resources: Array.from(this.servers.values()).flatMap((server) => server.resources.map((resource) => ({
        server: server.info.name,
        ...resource
      }))),
      next_cursor: null
    };
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
    if (request.server) {
      const server = this.getServer(request.server);

      return {
        server: request.server,
        resource_templates: server.resourceTemplates,
        next_cursor: null
      };
    }

    return {
      server: null,
      resource_templates: Array.from(this.servers.values()).flatMap((server) => (
        server.resourceTemplates.map((template) => ({
          server: server.info.name,
          ...template
        }))
      )),
      next_cursor: null
    };
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
    const server = this.getServer(request.server);
    const uri = String(request.uri ?? "");
    const content = server.resourceContents.get(uri);

    if (!content) {
      throw createMcpClientError(
        MCP_ERRORS.RESOURCE_NOT_FOUND,
        `MCP resource not found: ${request.server}/${uri}`
      );
    }

    return {
      server: request.server,
      uri,
      contents: Array.isArray(content)
        ? content.map(normalizeMcpResourceContent)
        : [normalizeMcpResourceContent(content)]
    };
  }

  /**
   * 获取 get server 相关数据。
   *
   * @param {unknown} serverName - serverName 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  getServer(serverName) {
    const server = this.servers.get(String(serverName ?? ""));

    if (!server) {
      throw createMcpClientError(
        MCP_ERRORS.SERVER_NOT_FOUND,
        `MCP server not found: ${serverName}`
      );
    }

    return server;
  }
}

/**
 * 创建 create mcp client error 相关数据。
 *
 * @param {unknown} code - code 参数。
 * @param {unknown} message - message 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createMcpClientError(code, message, options = {}) {
  const error = new Error(String(message ?? code));
  error.code = code;
  error.raw = options.raw ?? null;

  return error;
}
