/**
 * 中文模块说明：src/model-adapters/openai-compatible-model-client.js
 *
 * 模型适配器，把不同模型供应商响应统一成运行时事件。
 */
import {
  ModelClient,
  ModelClientSession,
  createModelResponseItem
} from "../core/model-client.js";

/**
 * 定义 OpenAICompatibleModelClient 类，封装当前模块的状态和行为。
 */
export class OpenAICompatibleModelClient extends ModelClient {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    super();
    this.baseUrl = String(options.baseUrl ?? options.base_url ?? options.url ?? "").replace(/\/+$/u, "");
    this.apiKey = options.apiKey ?? options.api_key ?? null;
    this.model = String(options.model ?? "");
    this.headers = options.headers && typeof options.headers === "object" ? { ...options.headers } : {};
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? options.timeout_ms, 60_000);
    this.defaultOptions = normalizeChatCompletionOptions(options);
    this.schemaCompatibility = String(options.schemaCompatibility ?? options.schema_compatibility ?? "openai");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.systemPrompt = options.systemPrompt ?? options.system_prompt ?? null;
    this.defaultSystemPrompt = options.defaultSystemPrompt ?? options.default_system_prompt ?? defaultCodexJsSystemPrompt();
    this.sessions = [];

    if (!this.baseUrl) {
      throw new Error("OpenAICompatibleModelClient requires a baseUrl.");
    }

    if (!this.model) {
      throw new Error("OpenAICompatibleModelClient requires a model.");
    }

    if (typeof this.fetch !== "function") {
      throw new Error("OpenAICompatibleModelClient requires fetch support.");
    }
  }

  /**
   * 创建 create session 相关数据。
   *
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  createSession(options = {}) {
    const session = new OpenAICompatibleModelClientSession({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      headers: this.headers,
      timeoutMs: this.timeoutMs,
      fetch: this.fetch,
      systemPrompt: options.systemPrompt ?? this.systemPrompt,
      defaultSystemPrompt: options.defaultSystemPrompt ?? this.defaultSystemPrompt,
      defaultOptions: this.defaultOptions,
      schemaCompatibility: this.schemaCompatibility
    });

    this.sessions.push(session);
    this.lastSession = session;
    return session;
  }
}

/**
 * 定义 OpenAICompatibleModelClientSession 类，封装当前模块的状态和行为。
 */
export class OpenAICompatibleModelClientSession extends ModelClientSession {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    super();
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.headers = options.headers ?? {};
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? options.timeout_ms, 60_000);
    this.defaultOptions = options.defaultOptions ?? {};
    this.schemaCompatibility = options.schemaCompatibility ?? "openai";
    this.fetch = options.fetch;
    this.systemPrompt = options.systemPrompt ?? null;
    this.defaultSystemPrompt = options.defaultSystemPrompt ?? defaultCodexJsSystemPrompt();
    this.messages = [];
    this.prompts = [];
    this.consumedResponseInputItemCount = 0;
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
    const messages = this.buildMessages(prompt);
    const response = await this.postChatCompletions(messages, {
      tools: prompt.tools ?? []
    });
    const choice = response.choices?.[0] ?? {};
    const message = choice.message ?? {};

    if (message.reasoning_content) {
      yield createModelResponseItem({
        type: "reasoning",
        text: message.reasoning_content,
        summaryText: message.reasoning_content,
        raw: message
      });
    }

    for (const toolCall of message.tool_calls ?? []) {
      yield openAiToolCallToModelItem(toolCall);
    }

    if (typeof message.content === "string" && message.content) {
      yield createModelResponseItem({
        text: message.content,
        raw: message
      });
    }

    this.messages = messages
      .filter((entry) => entry?.role !== "system")
      .concat([{
        role: "assistant",
        ...message
      }]);
    this.consumedResponseInputItemCount = (prompt.responseInputItems ?? []).length;
  }

  /**
   * 处理 build messages 相关逻辑。
   *
   * @param {unknown} prompt - prompt 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  buildMessages(prompt) {
    const messages = [];

    const systemPrompt = this.buildSystemPrompt(prompt);

    if (systemPrompt) {
      messages.push({
        role: "system",
        content: systemPrompt
      });
    }

    messages.push(...this.messages.filter((message) => message?.role));

    if (this.messages.length === 0 || (prompt.responseInputItems ?? []).length === 0) {
      messages.push({
        role: "user",
        content: promptToUserContent(prompt)
      });
    }

    const canReplayToolOutputs = this.messages.length > 0;

    if (canReplayToolOutputs) {
      const pendingToolCallIds = latestAssistantToolCallIds(this.messages);
      const responseInputItems = (prompt.responseInputItems ?? [])
        .slice(this.consumedResponseInputItemCount);

      for (const [index, item] of responseInputItems.entries()) {
        const toolCallId = toolOutputCallId(item) ?? pendingToolCallIds[index] ?? "";

        if (!toolCallId) {
          continue;
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: toolOutputToText(item.output)
        });
      }
    }

    return messages;
  }

  /**
   * 处理 build system prompt 相关逻辑。
   *
   * @param {unknown} prompt - prompt 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  buildSystemPrompt(prompt) {
    return [
      this.defaultSystemPrompt,
      this.systemPrompt,
      prompt?.workingDirectory ? `Current working directory: ${prompt.workingDirectory}` : "",
      prompt?.memoryContextText ? String(prompt.memoryContextText) : "",
      prompt?.doneCriteriaText ? String(prompt.doneCriteriaText) : ""
    ].filter(Boolean).join("\n\n");
  }

  /**
   * 处理 post chat completions 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} messages - messages 参数。
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async postChatCompletions(messages, options = {}) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const tools = chatCompletionToolsFromModelTools(options.tools ?? [], {
      schemaCompatibility: this.schemaCompatibility
    });
    const body = {
      model: this.model,
      messages,
      ...this.defaultOptions
    };

    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = this.defaultOptions.tool_choice ?? "auto";
    }

    try {
      const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.headers
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(await formatModelEndpointError(response));
      }

      return await response.json();
    } catch (error) {
      if (timedOut || isAbortError(error)) {
        throw new Error(`model endpoint timed out after ${this.timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * 创建 create open aicompatible model client 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createOpenAICompatibleModelClient(options = {}) {
  return new OpenAICompatibleModelClient(options);
}

/**
 * 创建 create deep seek model client 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createDeepSeekModelClient(options = {}) {
  return createOpenAICompatibleModelClient({
    ...options,
    baseUrl: options.baseUrl ?? options.base_url ?? "https://api.deepseek.com",
    model: normalizeDeepSeekModelName(options.model ?? "deepseek-v4-pro"),
    timeoutMs: options.timeoutMs ?? options.timeout_ms ?? 180_000,
    schemaCompatibility: "deepseek"
  });
}

/**
 * 归一化 normalize deep seek model name 相关数据。
 *
 * @param {unknown} model - model 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeDeepSeekModelName(model) {
  const normalized = String(model ?? "").trim();

  if (normalized === "v4-pro") {
    return "deepseek-v4-pro";
  }

  if (normalized === "v4-flash") {
    return "deepseek-v4-flash";
  }

  return normalized || "deepseek-v4-pro";
}

/**
 * 处理 default codex js system prompt 相关逻辑。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function defaultCodexJsSystemPrompt(options = {}) {
  const platform = options.platform ?? process.platform;
  const shell = platform === "win32" ? "Windows PowerShell" : "POSIX sh";

  return [
    "You are codex-js, a terminal coding agent. Use tools to inspect or change local files when the user asks you to.",
    `The runtime shell is ${shell}.`,
    "When writing files, prefer the apply_patch tool over shell commands.",
    "For apply_patch, the patch argument must contain the full canonical patch text, not a natural-language instruction.",
    "Canonical add-file patch format:",
    "*** Begin Patch\n*** Add File: index.html\n+file contents here\n*** End Patch",
    "Do not call write_stdin unless you already have a session_id returned by exec_command.",
    "On Windows PowerShell, do not use /root, cat heredocs, or POSIX-only operators like &&. Use the current working directory unless the user provided another cwd.",
    "If a tool fails, correct the tool arguments and continue instead of repeating the same failing call."
  ].join("\n");
}

/**
 * 处理 open ai tool call to model item 相关逻辑。
 *
 * @param {unknown} toolCall - toolCall 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function openAiToolCallToModelItem(toolCall) {
  const fn = toolCall.function ?? {};

  return createModelResponseItem({
    type: "function_call",
    callId: toolCall.id,
    name: fn.name,
    arguments: fn.arguments ?? "{}",
    raw: toolCall
  });
}

/**
 * 处理 prompt to user content 相关逻辑。
 *
 * @param {unknown} prompt - prompt 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function promptToUserContent(prompt) {
  const parts = [
    prompt.inputText ?? ""
  ];

  return parts.filter(Boolean).join("\n");
}

/**
 * 处理 tool output to text 相关逻辑。
 *
 * @param {unknown} output - output 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function toolOutputToText(output) {
  if (typeof output === "string") {
    return output;
  }

  if (output?.body != null) {
    return String(output.body);
  }

  return JSON.stringify(output ?? {});
}

/**
 * 处理 tool output call id 相关逻辑。
 *
 * @param {unknown} item - item 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function toolOutputCallId(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  return nonEmptyString(
    item.call_id ??
    item.callId ??
    item.tool_call_id ??
    item.toolCallId ??
    item.id
  );
}

/**
 * 处理 latest assistant tool call ids 相关逻辑。
 *
 * @param {unknown} messages - messages 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function latestAssistantToolCallIds(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      continue;
    }

    return message.tool_calls
      .map((toolCall) => nonEmptyString(toolCall?.id))
      .filter(Boolean);
  }

  return [];
}

/**
 * 处理 non empty string 相关逻辑。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function nonEmptyString(value) {
  const text = value == null ? "" : String(value);

  return text ? text : null;
}

/**
 * 处理 chat completion tools from model tools 相关逻辑。
 *
 * @param {unknown} tools - tools 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function chatCompletionToolsFromModelTools(tools = [], options = {}) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => chatCompletionToolFromModelTool(tool, options))
    .filter(Boolean);
}

/**
 * 处理 chat completion tool from model tool 相关逻辑。
 *
 * @param {unknown} tool - tool 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function chatCompletionToolFromModelTool(tool, options = {}) {
  if (!tool || typeof tool !== "object") {
    return null;
  }

  if (tool.type !== "function") {
    return null;
  }

  const parameters = tool.parameters && typeof tool.parameters === "object"
    ? normalizeToolJsonSchema(tool.parameters, options)
    : {
        type: "object",
        properties: {},
        additionalProperties: false
      };
  const fn = {
    name: String(tool.name ?? ""),
    description: String(tool.description ?? ""),
    parameters
  };

  if (!fn.name) {
    return null;
  }

  if (tool.strict === true) {
    fn.strict = true;
  }

  return {
    type: "function",
    function: fn
  };
}

/**
 * 归一化 normalize tool json schema 相关数据。
 *
 * @param {unknown} schema - schema 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeToolJsonSchema(schema, options = {}) {
  if (schema == null || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((entry) => normalizeToolJsonSchema(entry, options));
  }

  const normalized = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "output_schema") {
      continue;
    }

    if (options.schemaCompatibility === "deepseek" && key === "oneOf") {
      normalized.anyOf = normalizeToolJsonSchema(value, options);
      continue;
    }

    normalized[key] = normalizeToolJsonSchema(value, options);
  }

  return normalized;
}

/**
 * 归一化 normalize chat completion options 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeChatCompletionOptions(options = {}) {
  const passthroughKeys = [
    "temperature",
    "top_p",
    "max_tokens",
    "presence_penalty",
    "frequency_penalty",
    "response_format",
    "tool_choice",
    "parallel_tool_calls",
    "stop"
  ];
  const normalized = {};

  for (const key of passthroughKeys) {
    if (options[key] !== undefined) {
      normalized[key] = options[key];
    }
  }

  return normalized;
}

/**
 * 归一化 normalize timeout ms 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @param {unknown} fallback - fallback 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeTimeoutMs(value, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }

  return Math.trunc(number);
}

/**
 * 判断是否为 is abort error 相关数据。
 *
 * @param {unknown} error - error 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function isAbortError(error) {
  return error?.name === "AbortError" ||
    /aborted|aborterror|operation was aborted/iu.test(String(error?.message ?? error ?? ""));
}

/**
 * 格式化 format model endpoint error 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} response - response 参数。
 * @returns {unknown} 返回处理后的结果。
 */
async function formatModelEndpointError(response) {
  const text = await readErrorBody(response);
  const detail = text ? `: ${text}` : "";

  return `model endpoint failed: ${response.status} ${response.statusText}${detail}`;
}

/**
 * 读取 read error body 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} response - response 参数。
 * @returns {unknown} 返回处理后的结果。
 */
async function readErrorBody(response) {
  try {
    if (typeof response.text === "function") {
      const text = await response.text();

      return redactErrorText(text);
    }

    if (typeof response.json === "function") {
      return redactErrorText(JSON.stringify(await response.json()));
    }
  } catch {
    return "";
  }

  return "";
}

/**
 * 脱敏 redact error text 相关数据。
 *
 * @param {unknown} text - text 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function redactErrorText(text) {
  return String(text ?? "")
    .replace(/sk-[A-Za-z0-9_-]+/gu, "sk-[redacted]")
    .slice(0, 2000);
}
