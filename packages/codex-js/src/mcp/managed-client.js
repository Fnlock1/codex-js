/**
 * 中文模块说明：src/mcp/managed-client.js
 *
 * MCP 客户端、stdio 连接、协议转换和运行时封装。
 */
import {
  MCP_ERRORS,
  createMcpCallToolResult
} from "./protocol.js";
import { McpClient, createMcpClientError } from "./client.js";
import {
  MCP_SERVER_STATUSES,
  McpServerRegistry,
  serverResourceContentToResult
} from "./server-registry.js";
import {
  StdioMcpClient
} from "./stdio-client.js";

/**
 * 定义 ManagedMcpClient 类，封装当前模块的状态和行为。
 */
export class ManagedMcpClient extends McpClient {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    super();
    this.registry = options.registry ?? new McpServerRegistry({
      servers: options.servers ?? []
    });
    this.allowStdioSpawn = Boolean(options.allowStdioSpawn ?? false);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
    this.clients = new Map();
  }

  /**
   * 列出 list servers 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
  async listServers() {
    return this.registry.listServerInfo();
  }

  /**
   * 列出 list server statuses 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
  async listServerStatuses() {
    return this.registry.list().map((server) => ({
      name: server.info.name,
      title: server.info.title,
      version: server.info.version,
      status: server.status,
      error: server.error,
      disabled: server.config.disabled
    }));
  }

  /**
   * 处理 refresh server 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} serverName - serverName 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async refreshServer(serverName) {
    const server = this.registry.get(serverName);

    if (server.config.disabled) {
      await this.closeServer(server.info.name);
      return this.registry.setStatus(server.info.name, MCP_SERVER_STATUSES.DISCONNECTED);
    }

    if (shouldUseLiveStdioServer(server)) {
      try {
        const client = await this.ensureLiveClient(server);
        const [info] = await client.listServers();
        const tools = await client.listTools(server.info.name);

        this.registry.updateCapabilities(server.info.name, {
          info,
          tools
        });

        return this.registry.setStatus(server.info.name, MCP_SERVER_STATUSES.CONNECTED);
      } catch (error) {
        await this.closeServer(server.info.name);
        return this.registry.setStatus(
          server.info.name,
          MCP_SERVER_STATUSES.FAILED,
          error.message ?? String(error)
        );
      }
    }

    return this.registry.setStatus(server.info.name, MCP_SERVER_STATUSES.CONNECTED);
  }

  /**
   * 处理 refresh all 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
  async refreshAll() {
    const statuses = [];

    for (const server of this.registry.list()) {
      statuses.push(await this.refreshServer(server.info.name));
    }

    return statuses;
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
    const liveClient = this.clients.get(String(serverName ?? ""));

    if (liveClient) {
      const tools = await liveClient.listTools(serverName);
      this.registry.updateCapabilities(serverName, {
        tools
      });
      return tools;
    }

    return this.registry.get(serverName).tools;
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
    const server = this.registry.get(request.server);
    const liveClient = this.clients.get(server.info.name);

    if (liveClient) {
      return await liveClient.callTool(request);
    }

    const toolName = String(request.tool ?? "");
    const result = server.tool_results.get(toolName);

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
      const server = this.registry.get(request.server);
      const liveClient = this.clients.get(server.info.name);

      if (liveClient) {
        const result = await liveClient.listResources(request);
        this.registry.updateCapabilities(server.info.name, {
          resources: result.resources
        });
        return result;
      }

      return {
        server: request.server,
        resources: server.resources,
        next_cursor: null
      };
    }

    return {
      server: null,
      resources: this.registry.list().flatMap((server) => server.resources.map((resource) => ({
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
      const server = this.registry.get(request.server);
      const liveClient = this.clients.get(server.info.name);

      if (liveClient) {
        const result = await liveClient.listResourceTemplates(request);
        this.registry.updateCapabilities(server.info.name, {
          resource_templates: result.resource_templates
        });
        return result;
      }

      return {
        server: request.server,
        resource_templates: server.resource_templates,
        next_cursor: null
      };
    }

    return {
      server: null,
      resource_templates: this.registry.list().flatMap((server) => (
        server.resource_templates.map((template) => ({
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
    const server = this.registry.get(request.server);
    const liveClient = this.clients.get(server.info.name);

    if (liveClient) {
      return await liveClient.readResource(request);
    }

    const uri = String(request.uri ?? "");
    const content = server.resource_contents.get(uri);

    if (!content) {
      throw createMcpClientError(
        MCP_ERRORS.RESOURCE_NOT_FOUND,
        `MCP resource not found: ${request.server}/${uri}`
      );
    }

    return serverResourceContentToResult(request.server, uri, content);
  }

  /**
   * 处理 close server 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} serverName - serverName 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async closeServer(serverName) {
    const key = String(serverName ?? "");
    const client = this.clients.get(key);

    if (client && typeof client.close === "function") {
      await client.close();
    }

    this.clients.delete(key);
  }

  /**
   * 处理 close all 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
  async closeAll() {
    for (const serverName of [...this.clients.keys()]) {
      await this.closeServer(serverName);
    }
  }

  /**
   * 处理 ensure live client 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} server - server 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async ensureLiveClient(server) {
    const existing = this.clients.get(server.info.name);

    if (existing) {
      return existing;
    }

    const client = new StdioMcpClient({
      server,
      allowSpawn: this.allowStdioSpawn,
      defaultTimeoutMs: this.defaultTimeoutMs
    });

    await client.connect();
    this.clients.set(server.info.name, client);
    return client;
  }
}

/**
 * 创建 create managed mcp client 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createManagedMcpClient(options = {}) {
  return new ManagedMcpClient(options);
}

/**
 * 处理 should use live stdio server 相关逻辑。
 *
 * @param {unknown} server - server 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function shouldUseLiveStdioServer(server) {
  return (
    server.config.transport === "stdio" &&
    Boolean(server.config.command) &&
    server.tools.length === 0 &&
    server.tool_results.size === 0
  );
}
