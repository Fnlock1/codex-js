/**
 * 中文模块说明：src/app-server/transport.js
 *
 * 面向 UI 或守护进程的 JSONL/RPC app-server 协议层。
 */
import readline from "node:readline";
import {
  APP_SERVER_ERROR_CODES,
  createRpcError
} from "./protocol.js";
import { createCodexAppServer } from "./server.js";

/**
 * 定义 InProcessAppServerTransport 类，封装当前模块的状态和行为。
 */
export class InProcessAppServerTransport {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.server = options.server ?? createCodexAppServer(options);
    this.sent = [];
  }

  /**
   * 处理 send 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} message - message 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async send(message) {
    const parsed = typeof message === "string" ? JSON.parse(message) : message;
    const response = await this.server.handle(parsed);

    if (response) {
      this.sent.push(response);
    }

    return response;
  }

  /**
   * 处理 notifications 相关逻辑。
   * @returns {unknown} 返回处理后的结果。
   */
  notifications() {
    return [...this.server.notifications];
  }
}

/**
 * 创建 create in process app server transport 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createInProcessAppServerTransport(options = {}) {
  return new InProcessAppServerTransport(options);
}

/**
 * 定义 StdioAppServerTransport 类，封装当前模块的状态和行为。
 */
export class StdioAppServerTransport {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
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

  /**
   * 启动 start 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
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

  /**
   * 处理 handle line 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} line - line 参数。
   * @returns {unknown} 返回处理后的结果。
   */
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

  /**
   * 写入 write message 相关数据。
   *
   * @param {unknown} message - message 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  writeMessage(message) {
    const normalized = normalizeWireMessage(message);
    this.sent.push(normalized);
    this.output.write(`${JSON.stringify(normalized)}\n`);
  }

  /**
   * 处理 notifications 相关逻辑。
   * @returns {unknown} 返回处理后的结果。
   */
  notifications() {
    return [...this.server.notifications];
  }
}

/**
 * 创建 create stdio app server transport 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createStdioAppServerTransport(options = {}) {
  return new StdioAppServerTransport(options);
}

/**
 * 归一化 normalize wire message 相关数据。
 *
 * @param {unknown} message - message 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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
