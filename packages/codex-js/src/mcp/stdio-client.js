import { spawn } from "node:child_process";
import readline from "node:readline";
import { McpClient, createMcpClientError } from "./client.js";
import {
  MCP_ERRORS,
  createMcpCallToolResult,
  normalizeMcpResource,
  normalizeMcpResourceContent,
  normalizeMcpResourceTemplate,
  normalizeMcpServerInfo,
  normalizeMcpTool
} from "./protocol.js";

export class StdioMcpClient extends McpClient {
  constructor(options = {}) {
    super();
    this.server = normalizeStdioMcpServer(options.server ?? options);
    this.allowSpawn = Boolean(options.allowSpawn ?? false);
    this.defaultTimeoutMs = normalizePositiveInteger(options.defaultTimeoutMs, 5000);
    this.process = null;
    this.lineReader = null;
    this.nextId = 1;
    this.pending = new Map();
    this.connected = false;
    this.initialized = false;
    this.serverInfo = normalizeMcpServerInfo(this.server.info);
    this.tools = [];
    this.resources = [];
    this.resourceTemplates = [];
    this.stderr = "";
  }

  async connect() {
    if (this.connected) {
      return this.serverInfo;
    }

    if (!this.allowSpawn) {
      throw createMcpClientError(
        MCP_ERRORS.START_BLOCKED,
        "MCP stdio process spawn is blocked by configuration."
      );
    }

    if (!this.server.config.command) {
      throw createMcpClientError(
        MCP_ERRORS.START_FAILED,
        "MCP stdio server command is required."
      );
    }

    this.process = spawn(this.server.config.command, this.server.config.args, {
      cwd: this.server.config.cwd ?? undefined,
      env: {
        ...process.env,
        ...this.server.config.env
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    this.process.once("error", (error) => {
      this.rejectAll(createMcpClientError(MCP_ERRORS.START_FAILED, error.message, {
        raw: error
      }));
    });
    this.process.once("exit", (code, signal) => {
      this.connected = false;
      this.initialized = false;
      this.rejectAll(createMcpClientError(
        MCP_ERRORS.NOT_CONNECTED,
        `MCP stdio server exited with code ${code ?? "null"} signal ${signal ?? "null"}.`
      ));
    });

    this.lineReader = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
      terminal: false
    });
    this.lineReader.on("line", (line) => this.handleLine(line));
    this.process.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });

    this.connected = true;

    const initialized = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "codex-js",
        version: "0.1.0"
      }
    });

    this.initialized = true;
    this.serverInfo = normalizeMcpServerInfo({
      ...this.server.info,
      ...(initialized.serverInfo ?? initialized.server_info ?? {})
    });
    this.notify("notifications/initialized", {});

    return this.serverInfo;
  }

  async close() {
    this.connected = false;
    this.initialized = false;
    this.lineReader?.close();
    this.lineReader = null;

    if (this.process && !this.process.killed) {
      this.process.kill();
    }

    this.process = null;
    this.rejectAll(createMcpClientError(MCP_ERRORS.NOT_CONNECTED, "MCP stdio client closed."));
  }

  async listServers() {
    await this.ensureConnected();
    return [this.serverInfo];
  }

  async listTools() {
    await this.ensureConnected();
    const response = await this.request("tools/list", {});
    this.tools = (response.tools ?? []).map(normalizeMcpTool);
    return this.tools;
  }

  async callTool(request = {}) {
    await this.ensureConnected();
    const response = await this.request("tools/call", {
      name: String(request.tool ?? ""),
      arguments: request.arguments ?? {}
    });

    return createMcpCallToolResult(response);
  }

  async listResources() {
    await this.ensureConnected();
    const response = await this.request("resources/list", {});
    this.resources = (response.resources ?? []).map(normalizeMcpResource);

    return {
      server: this.serverInfo.name,
      resources: this.resources,
      next_cursor: response.nextCursor ?? response.next_cursor ?? null
    };
  }

  async listResourceTemplates() {
    await this.ensureConnected();
    const response = await this.request("resources/templates/list", {});
    this.resourceTemplates = (response.resourceTemplates ?? response.resource_templates ?? [])
      .map(normalizeMcpResourceTemplate);

    return {
      server: this.serverInfo.name,
      resource_templates: this.resourceTemplates,
      next_cursor: response.nextCursor ?? response.next_cursor ?? null
    };
  }

  async readResource(request = {}) {
    await this.ensureConnected();
    const uri = String(request.uri ?? "");
    const response = await this.request("resources/read", {
      uri
    });

    return {
      server: this.serverInfo.name,
      uri,
      contents: (response.contents ?? []).map(normalizeMcpResourceContent)
    };
  }

  async ensureConnected() {
    if (!this.connected || !this.initialized) {
      await this.connect();
    }
  }

  async request(method, params = {}, options = {}) {
    if (!this.process?.stdin?.writable) {
      throw createMcpClientError(MCP_ERRORS.NOT_CONNECTED, "MCP stdio client is not connected.");
    }

    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = normalizePositiveInteger(options.timeoutMs, this.defaultTimeoutMs);
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(createMcpClientError(MCP_ERRORS.PROTOCOL_ERROR, `MCP request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer
      });
    });

    this.process.stdin.write(`${JSON.stringify(message)}\n`);
    return await promise;
  }

  notify(method, params = {}) {
    if (!this.process?.stdin?.writable) {
      return;
    }

    this.process.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method,
      params
    })}\n`);
  }

  handleLine(line) {
    const text = String(line ?? "").trim();

    if (!text) {
      return;
    }

    let message;

    try {
      message = JSON.parse(text);
    } catch (error) {
      this.rejectAll(createMcpClientError(MCP_ERRORS.PROTOCOL_ERROR, `Invalid MCP JSON: ${error.message}`));
      return;
    }

    if (message.id == null) {
      return;
    }

    const pending = this.pending.get(message.id);

    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(createMcpClientError(
        MCP_ERRORS.PROTOCOL_ERROR,
        message.error.message ?? `MCP request failed: ${pending.method}`,
        {
          raw: message.error
        }
      ));
      return;
    }

    pending.resolve(message.result ?? {});
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    this.pending.clear();
  }
}

export function createStdioMcpClient(options = {}) {
  return new StdioMcpClient(options);
}

export function normalizeStdioMcpServer(server = {}) {
  const config = server.config ?? server;
  const name = server.info?.name ?? server.name ?? config.name ?? "stdio";

  return {
    info: normalizeMcpServerInfo({
      name,
      ...(server.info ?? {})
    }),
    config: {
      command: config.command == null ? null : String(config.command),
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      env: config.env && typeof config.env === "object" ? { ...config.env } : {},
      cwd: config.cwd == null ? null : String(config.cwd)
    }
  };
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
