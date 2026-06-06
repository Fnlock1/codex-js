export class HttpHostedToolProvider {
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

export function createHttpHostedToolProvider(options = {}) {
  return new HttpHostedToolProvider(options);
}
