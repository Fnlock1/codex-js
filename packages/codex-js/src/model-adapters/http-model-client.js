import {
  ModelClient,
  ModelClientSession
} from "../core/model-client.js";
import {
  normalizeAdapterResponse
} from "./plugin-model-client.js";

export class HttpModelClient extends ModelClient {
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

export class HttpModelClientSession extends ModelClientSession {
  constructor(options = {}) {
    super();
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 60000;
    this.fetch = options.fetch;
    this.sessionOptions = options.sessionOptions ?? {};
    this.prompts = [];
  }

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

export function createHttpModelClient(options = {}) {
  return new HttpModelClient(options);
}

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

async function readJsonLines(response) {
  const text = await response.text();

  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
