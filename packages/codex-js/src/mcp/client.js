import {
  MCP_ERRORS,
  createMcpCallToolResult,
  normalizeMcpResource,
  normalizeMcpResourceContent,
  normalizeMcpResourceTemplate,
  normalizeMcpServerInfo,
  normalizeMcpTool
} from "./protocol.js";

export class McpClient {
  async listServers() {
    throw createMcpClientError(MCP_ERRORS.NOT_CONNECTED, "MCP client is not connected.");
  }

  async listTools(_serverName) {
    throw createMcpClientError(MCP_ERRORS.NOT_CONNECTED, "MCP client is not connected.");
  }

  async callTool(_request) {
    throw createMcpClientError(MCP_ERRORS.NOT_CONNECTED, "MCP client is not connected.");
  }

  async listResources(_request = {}) {
    throw createMcpClientError(MCP_ERRORS.NOT_CONNECTED, "MCP client is not connected.");
  }

  async listResourceTemplates(_request = {}) {
    throw createMcpClientError(MCP_ERRORS.NOT_CONNECTED, "MCP client is not connected.");
  }

  async readResource(_request = {}) {
    throw createMcpClientError(MCP_ERRORS.NOT_CONNECTED, "MCP client is not connected.");
  }
}

export class NotConnectedMcpClient extends McpClient {}

export class StaticMcpClient extends McpClient {
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

  async listServers() {
    return Array.from(this.servers.values()).map((server) => server.info);
  }

  async listTools(serverName) {
    const server = this.getServer(serverName);

    return server.tools;
  }

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

export function createMcpClientError(code, message, options = {}) {
  const error = new Error(String(message ?? code));
  error.code = code;
  error.raw = options.raw ?? null;

  return error;
}
