/**
 * 中文模块说明：src/tools/hosted-providers.js
 *
 * 工具定义、路由、handler、内置工具和上游工具格式转换。
 */
export class HttpHostedToolProvider {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.url = String(options.url ?? "");
    this.headers = options.headers && typeof options.headers === "object"
      ? { ...options.headers }
      : {};
    this.timeoutMs = Number(options.timeoutMs ?? options.timeout_ms ?? 30_000);
    this.fetch = options.fetch ?? globalThis.fetch;

    if (!this.url) {
      throw new Error("HttpHostedToolProvider requires a url.");
    }

    if (typeof this.fetch !== "function") {
      throw new Error("HttpHostedToolProvider requires fetch support.");
    }
  }

  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} args - args 参数。
   * @param {unknown} context - context 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async run(args = {}, context = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.headers
        },
        body: JSON.stringify({
          kind: context.kind,
          arguments: args,
          tool: context.request?.name ?? null
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`hosted provider failed: ${response.status} ${response.statusText}`);
      }

      const contentType = response.headers?.get?.("content-type") ?? "";

      if (contentType.includes("application/json")) {
        return await response.json();
      }

      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * 创建 create http hosted tool provider 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createHttpHostedToolProvider(options = {}) {
  return new HttpHostedToolProvider(options);
}
