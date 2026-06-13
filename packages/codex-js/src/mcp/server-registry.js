/**
 * 中文模块说明：src/mcp/server-registry.js
 *
 * MCP 客户端、stdio 连接、协议转换和运行时封装。
 */
import {
  MCP_ERRORS,
  normalizeMcpResource,
  normalizeMcpResourceContent,
  normalizeMcpResourceTemplate,
  normalizeMcpServerInfo,
  normalizeMcpTool
} from "./protocol.js";
import { createMcpClientError } from "./client.js";

export const MCP_SERVER_STATUSES = Object.freeze({
  DISCONNECTED: "disconnected",
  CONNECTED: "connected",
  FAILED: "failed"
});

/**
 * 定义 McpServerRegistry 类，封装当前模块的状态和行为。
 */
export class McpServerRegistry {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.servers = new Map();

    for (const server of options.servers ?? []) {
      this.register(server);
    }
  }

  /**
   * 处理 register 相关逻辑。
   *
   * @param {unknown} server - server 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  register(server = {}) {
    const definition = normalizeMcpServerDefinition(server);

    if (this.servers.has(definition.info.name)) {
      throw new Error(`MCP server already registered: ${definition.info.name}`);
    }

    this.servers.set(definition.info.name, definition);
    return definition;
  }

  /**
   * 处理 upsert 相关逻辑。
   *
   * @param {unknown} server - server 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  upsert(server = {}) {
    const definition = normalizeMcpServerDefinition(server);

    this.servers.set(definition.info.name, definition);
    return definition;
  }

  /**
   * 处理 unregister 相关逻辑。
   *
   * @param {unknown} serverName - serverName 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  unregister(serverName) {
    return this.servers.delete(String(serverName ?? ""));
  }

  /**
   * 判断是否存在 has 相关数据。
   *
   * @param {unknown} serverName - serverName 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  has(serverName) {
    return this.servers.has(String(serverName ?? ""));
  }

  /**
   * 获取 get 相关数据。
   *
   * @param {unknown} serverName - serverName 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  get(serverName) {
    const server = this.servers.get(String(serverName ?? ""));

    if (!server) {
      throw createMcpClientError(
        MCP_ERRORS.SERVER_NOT_FOUND,
        `MCP server not found: ${serverName}`
      );
    }

    return server;
  }

  /**
   * 列出 list 相关数据。
   * @returns {unknown} 返回处理后的结果。
   */
  list() {
    return Array.from(this.servers.values()).map((server) => cloneMcpServerDefinition(server));
  }

  /**
   * 列出 list server info 相关数据。
   * @returns {unknown} 返回处理后的结果。
   */
  listServerInfo() {
    return this.list().map((server) => server.info);
  }

  /**
   * 设置 set status 相关数据。
   *
   * @param {unknown} serverName - serverName 参数。
   * @param {unknown} status - status 参数。
   * @param {unknown} error - error 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  setStatus(serverName, status, error = null) {
    const server = this.get(serverName);
    server.status = status;
    server.error = error == null ? null : String(error);

    return cloneMcpServerDefinition(server);
  }

  /**
   * 处理 update capabilities 相关逻辑。
   *
   * @param {unknown} serverName - serverName 参数。
   * @param {unknown} updates - updates 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  updateCapabilities(serverName, updates = {}) {
    const server = this.get(serverName);

    if (updates.info) {
      server.info = normalizeMcpServerInfo({
        ...server.info,
        ...updates.info
      });
    }

    if (updates.tools) {
      server.tools = updates.tools.map(normalizeMcpTool);
    }

    if (updates.resources) {
      server.resources = updates.resources.map(normalizeMcpResource);
    }

    if (updates.resourceTemplates ?? updates.resource_templates) {
      server.resource_templates = (updates.resourceTemplates ?? updates.resource_templates)
        .map(normalizeMcpResourceTemplate);
    }

    return cloneMcpServerDefinition(server);
  }
}

/**
 * 归一化 normalize mcp server definition 相关数据。
 *
 * @param {unknown} server - server 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeMcpServerDefinition(server = {}) {
  const info = normalizeMcpServerInfo(server.info ?? server);

  if (!info.name) {
    throw new Error("MCP server name is required.");
  }

  return {
    info,
    status: server.status ?? MCP_SERVER_STATUSES.DISCONNECTED,
    error: server.error ?? null,
    config: normalizeMcpServerConfig(server.config ?? {}),
    tools: (server.tools ?? []).map(normalizeMcpTool),
    resources: (server.resources ?? []).map(normalizeMcpResource),
    resource_templates: (server.resourceTemplates ?? server.resource_templates ?? [])
      .map(normalizeMcpResourceTemplate),
    resource_contents: new Map(Object.entries(server.resourceContents ?? server.resource_contents ?? {})),
    tool_results: new Map(Object.entries(server.toolResults ?? server.tool_results ?? {}))
  };
}

/**
 * 归一化 normalize mcp server config 相关数据。
 *
 * @param {unknown} config - config 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeMcpServerConfig(config = {}) {
  return {
    command: config.command == null ? null : String(config.command),
    args: Array.isArray(config.args) ? config.args.map(String) : [],
    env: config.env && typeof config.env === "object" ? { ...config.env } : {},
    cwd: config.cwd == null ? null : String(config.cwd),
    transport: config.transport ?? "stdio",
    disabled: Boolean(config.disabled ?? false),
    autostart: Boolean(config.autostart ?? false)
  };
}

/**
 * 克隆 clone mcp server definition 相关数据。
 *
 * @param {unknown} server - server 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function cloneMcpServerDefinition(server) {
  return {
    ...server,
    info: { ...server.info },
    config: {
      ...server.config,
      args: [...server.config.args],
      env: { ...server.config.env }
    },
    tools: server.tools.map((tool) => ({ ...tool })),
    resources: server.resources.map((resource) => ({ ...resource })),
    resource_templates: server.resource_templates.map((template) => ({ ...template })),
    resource_contents: new Map(server.resource_contents),
    tool_results: new Map(server.tool_results)
  };
}

/**
 * 处理 server resource content to result 相关逻辑。
 *
 * @param {unknown} serverName - serverName 参数。
 * @param {unknown} uri - uri 参数。
 * @param {unknown} content - content 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function serverResourceContentToResult(serverName, uri, content) {
  return {
    server: String(serverName ?? ""),
    uri: String(uri ?? ""),
    contents: Array.isArray(content)
      ? content.map(normalizeMcpResourceContent)
      : [normalizeMcpResourceContent(content)]
  };
}
