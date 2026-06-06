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

export class ManagedMcpClient extends McpClient {
  constructor(options = {}) {
    super();
    this.registry = options.registry ?? new McpServerRegistry({
      servers: options.servers ?? []
    });
    this.allowStdioSpawn = Boolean(options.allowStdioSpawn ?? false);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
    this.clients = new Map();
  }

  async listServers() {
    return this.registry.listServerInfo();
  }

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

  async refreshAll() {
    const statuses = [];

    for (const server of this.registry.list()) {
      statuses.push(await this.refreshServer(server.info.name));
    }

    return statuses;
  }

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

  async closeServer(serverName) {
    const key = String(serverName ?? "");
    const client = this.clients.get(key);

    if (client && typeof client.close === "function") {
      await client.close();
    }

    this.clients.delete(key);
  }

  async closeAll() {
    for (const serverName of [...this.clients.keys()]) {
      await this.closeServer(serverName);
    }
  }

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

export function createManagedMcpClient(options = {}) {
  return new ManagedMcpClient(options);
}

function shouldUseLiveStdioServer(server) {
  return (
    server.config.transport === "stdio" &&
    Boolean(server.config.command) &&
    server.tools.length === 0 &&
    server.tool_results.size === 0
  );
}
