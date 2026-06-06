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

export class McpServerRegistry {
  constructor(options = {}) {
    this.servers = new Map();

    for (const server of options.servers ?? []) {
      this.register(server);
    }
  }

  register(server = {}) {
    const definition = normalizeMcpServerDefinition(server);

    if (this.servers.has(definition.info.name)) {
      throw new Error(`MCP server already registered: ${definition.info.name}`);
    }

    this.servers.set(definition.info.name, definition);
    return definition;
  }

  upsert(server = {}) {
    const definition = normalizeMcpServerDefinition(server);

    this.servers.set(definition.info.name, definition);
    return definition;
  }

  unregister(serverName) {
    return this.servers.delete(String(serverName ?? ""));
  }

  has(serverName) {
    return this.servers.has(String(serverName ?? ""));
  }

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

  list() {
    return Array.from(this.servers.values()).map((server) => cloneMcpServerDefinition(server));
  }

  listServerInfo() {
    return this.list().map((server) => server.info);
  }

  setStatus(serverName, status, error = null) {
    const server = this.get(serverName);
    server.status = status;
    server.error = error == null ? null : String(error);

    return cloneMcpServerDefinition(server);
  }

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

export function serverResourceContentToResult(serverName, uri, content) {
  return {
    server: String(serverName ?? ""),
    uri: String(uri ?? ""),
    contents: Array.isArray(content)
      ? content.map(normalizeMcpResourceContent)
      : [normalizeMcpResourceContent(content)]
  };
}
