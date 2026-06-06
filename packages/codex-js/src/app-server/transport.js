import readline from "node:readline";
import {
  APP_SERVER_ERROR_CODES,
  createRpcError
} from "./protocol.js";
import { createCodexAppServer } from "./server.js";

export class InProcessAppServerTransport {
  constructor(options = {}) {
    this.server = options.server ?? createCodexAppServer(options);
    this.sent = [];
  }

  async send(message) {
    const parsed = typeof message === "string" ? JSON.parse(message) : message;
    const response = await this.server.handle(parsed);

    if (response) {
      this.sent.push(response);
    }

    return response;
  }

  notifications() {
    return [...this.server.notifications];
  }
}

export function createInProcessAppServerTransport(options = {}) {
  return new InProcessAppServerTransport(options);
}

export class StdioAppServerTransport {
  constructor(options = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.sent = [];

    if (options.server) {
      this.server = options.server;
      const previousNotification = this.server.onNotification;
      const previousServerRequest = this.server.onServerRequest;
      this.server.onNotification = (notification) => {
        previousNotification?.(notification);
        options.onNotification?.(notification);
        this.writeMessage(notification);
      };
      this.server.onServerRequest = (request, pending) => {
        previousServerRequest?.(request, pending);
        options.onServerRequest?.(request, pending);
        this.writeMessage(request);
      };
    } else {
      this.server = createCodexAppServer({
        ...options,
        onNotification: (notification) => {
          options.onNotification?.(notification);
          this.writeMessage(notification);
        },
        onServerRequest: (request, pending) => {
          options.onServerRequest?.(request, pending);
          this.writeMessage(request);
        }
      });
    }
  }

  async start() {
    const lines = readline.createInterface({
      input: this.input,
      crlfDelay: Infinity,
      terminal: false
    });

    for await (const line of lines) {
      await this.handleLine(line);
    }
  }

  async handleLine(line) {
    const text = String(line ?? "").trim();

    if (!text) {
      return null;
    }

    let message;

    try {
      message = JSON.parse(text);
    } catch (error) {
      const response = createRpcError(
        null,
        APP_SERVER_ERROR_CODES.PARSE_ERROR,
        `Parse error: ${error.message}`
      );
      this.writeMessage(response);
      return response;
    }

    const response = await this.server.handle(message);

    if (response) {
      this.writeMessage(response);
    }

    return response;
  }

  writeMessage(message) {
    const normalized = normalizeWireMessage(message);
    this.sent.push(normalized);
    this.output.write(`${JSON.stringify(normalized)}\n`);
  }

  notifications() {
    return [...this.server.notifications];
  }
}

export function createStdioAppServerTransport(options = {}) {
  return new StdioAppServerTransport(options);
}

export function normalizeWireMessage(message) {
  if (!message || typeof message !== "object") {
    return message;
  }

  const {
    jsonrpc: _jsonrpc,
    ...rest
  } = message;

  return rest;
}
