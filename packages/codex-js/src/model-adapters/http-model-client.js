/**
 * 中文模块说明：src/model-adapters/http-model-client.js
 *
 * 模型适配器，把不同模型供应商响应统一成运行时事件。
 */
import {
  ModelClient,
  ModelClientSession
} from "../core/model-client.js";
import {
  normalizeAdapterResponse
} from "./plugin-model-client.js";

/**
 * 定义 HttpModelClient 类，封装当前模块的状态和行为。
 */
export class HttpModelClient extends ModelClient {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    super();
    this.url = String(options.url ?? "");
    this.headers = options.headers && typeof options.headers === "object"
      ? { ...options.headers }
      : {};
    this.timeoutMs = Number(options.timeoutMs ?? options.timeout_ms ?? 60000);
    this.sessionOptions = options.sessionOptions ?? options.options ?? {};
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sessions = [];

    if (!this.url) {
      throw new Error("HttpModelClient requires a url.");
    }

    if (typeof this.fetch !== "function") {
      throw new Error("HttpModelClient requires fetch support.");
    }
  }

  /**
   * 创建 create session 相关数据。
   *
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  createSession(options = {}) {
    const session = new HttpModelClientSession({
      url: this.url,
      headers: this.headers,
      timeoutMs: this.timeoutMs,
      fetch: this.fetch,
      sessionOptions: {
        ...this.sessionOptions,
        ...options
      }
    });

    this.sessions.push(session);
    this.lastSession = session;
    return session;
  }
}

/**
 * 定义 HttpModelClientSession 类，封装当前模块的状态和行为。
 */
export class HttpModelClientSession extends ModelClientSession {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    super();
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.fetch = options.fetch;
    this.sessionOptions = options.sessionOptions ?? {};
    this.prompts = [];
  }

  /**
   * 处理 stream response 相关逻辑。
   *
   * 这是异步生成器，会按需产出事件或结果。
   *
   * @param {unknown} prompt - prompt 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async *streamResponse(prompt) {
    this.prompts.push(prompt);

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.headers
        },
        body: JSON.stringify({
          prompt,
          session: this.sessionOptions
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`model endpoint failed: ${response.status} ${response.statusText}`);
      }

      yield* normalizeAdapterResponse(await readHttpModelResponse(response));
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * 创建 create http model client 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createHttpModelClient(options = {}) {
  return new HttpModelClient(options);
}

/**
 * 读取 read http model response 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} response - response 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function readHttpModelResponse(response) {
  const contentType = response.headers?.get?.("content-type") ?? "";

  if (contentType.includes("application/x-ndjson") || contentType.includes("application/jsonl")) {
    return await readJsonLines(response);
  }

  if (contentType.includes("application/json")) {
    return await response.json();
  }

  return await response.text();
}

/**
 * 读取 read json lines 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} response - response 参数。
 * @returns {unknown} 返回处理后的结果。
 */
async function readJsonLines(response) {
  const text = await response.text();

  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
