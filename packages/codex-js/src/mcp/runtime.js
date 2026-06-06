import { APPROVAL_DECISIONS } from "../approval/policy.js";
import {
  TOOL_CALL_RESULT_STATUSES,
  createToolCallResult
} from "../tools/runtime.js";
import { createToolApprovalGateRequest } from "../tools/handlers.js";
import { NotConnectedMcpClient } from "./client.js";
import {
  createMcpToolSpec,
  mcpCallToolResultToText,
  parseMcpToolName
} from "./protocol.js";

export class McpRuntime {
  constructor(options = {}) {
    this.client = options.client ?? new NotConnectedMcpClient();
    this.approvalGate = options.approvalGate ?? null;
  }

  async listServers() {
    return await this.client.listServers();
  }

  async listTools(serverName) {
    return await this.client.listTools(serverName);
  }

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

  async refresh() {
    if (typeof this.client.refreshAll !== "function") {
      return [];
    }

    return await this.client.refreshAll();
  }

  async discoverTools(options = {}) {
    if (options.refresh ?? true) {
      await this.refresh();
    }

    return await this.createToolDefinitions();
  }

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

  async callTool(request = {}) {
    const approval = this.checkApproval(request);

    if (approval && approval.decision !== APPROVAL_DECISIONS.ALLOW) {
      return createToolCallResult({
        callId: request.call_id,
        name: request.name,
        status: TOOL_CALL_RESULT_STATUSES.FAILED,
        output: `mcp tool blocked: ${approval.decision}`,
        error: `blocked: ${approval.decision}`,
        raw: {
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
          mcp: {
            server: request.server,
            tool: request.tool
          }
        }
      });
    }
  }

  async listResources(request = {}) {
    return await this.client.listResources(request);
  }

  async listResourceTemplates(request = {}) {
    return await this.client.listResourceTemplates(request);
  }

  async readResource(request = {}) {
    return await this.client.readResource(request);
  }

  checkApproval(request = {}) {
    if (!this.approvalGate) {
      return null;
    }

    return this.approvalGate.check(createToolApprovalGateRequest(request.name, {
      metadata: {
        source: "mcp",
        server: request.server,
        tool: request.tool,
        arguments: request.arguments
      }
    }));
  }
}

export class McpToolHandler {
  constructor(options = {}) {
    this.runtime = options.runtime ?? new McpRuntime();
    this.server = options.server ?? null;
    this.tool = options.tool ?? null;
  }

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

export function createMcpRuntime(options = {}) {
  return new McpRuntime(options);
}
