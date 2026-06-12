/**
 * 中文模块说明：src/core/model-client.js
 *
 * agent turn 上下文、模型调用抽象、工具循环和 ReAct trace。
 */
import {
  RESPONSE_ITEM_TYPES,
  createResponseCustomToolCallItem,
  createResponseFunctionCallItem,
  createResponseMessageItem,
  createResponseReasoningItem
} from "../protocol/index.js";

export const MODEL_RESPONSE_ITEM_TYPES = Object.freeze({
  ASSISTANT_MESSAGE: "assistant_message",
  REASONING: "reasoning",
  TOOL_CALL: "tool_call",
  FUNCTION_CALL: RESPONSE_ITEM_TYPES.FUNCTION_CALL,
  CUSTOM_TOOL_CALL: RESPONSE_ITEM_TYPES.CUSTOM_TOOL_CALL
});

/**
 * 定义 ModelClient 类，封装当前模块的状态和行为。
 */
export class ModelClient {
  /**
   * 创建 create session 相关数据。
   *
   * @param {unknown} _options - _options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  createSession(_options = {}) {
    return new ModelClientSession();
  }
}

/**
 * 定义 ModelClientSession 类，封装当前模块的状态和行为。
 */
export class ModelClientSession {
  /**
   * 处理 stream response 相关逻辑。
   *
   * 这是异步生成器，会按需产出事件或结果。
   *
   * @param {unknown} _prompt - _prompt 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async *streamResponse(_prompt) {
    throw new Error("ModelClientSession.streamResponse() must be implemented by a subclass.");
  }
}

/**
 * 定义 MockModelClient 类，封装当前模块的状态和行为。
 */
export class MockModelClient extends ModelClient {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    super();
    this.mockResponse = options.mockResponse;
    this.script = options.script ?? null;
    this.sessions = [];
  }

  /**
   * 创建 create session 相关数据。
   *
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  createSession(options = {}) {
    const session = new MockModelClientSession({
      mockResponse: options.mockResponse ?? this.mockResponse,
      script: options.script ?? this.script
    });

    this.sessions.push(session);
    this.lastSession = session;
    return session;
  }
}

/**
 * 定义 MockModelClientSession 类，封装当前模块的状态和行为。
 */
export class MockModelClientSession extends ModelClientSession {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    super();
    this.mockResponse = options.mockResponse;
    this.scriptedResponses = normalizeScriptedModelResponses(options.script);
    this.prompts = [];
    this.turnIndex = 0;
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
    this.prompts.push(modelPromptToJSON(prompt));

    if (this.scriptedResponses.length > 0) {
      const responseItems = responseItemsForScriptTurn(
        this.scriptedResponses,
        this.turnIndex,
        prompt
      );
      this.turnIndex += 1;

      for (const item of responseItems) {
        yield item;
      }
      return;
    }

    const text = this.mockResponse ?? defaultMockResponse(prompt.inputText);
    yield createModelResponseItem({
      type: MODEL_RESPONSE_ITEM_TYPES.ASSISTANT_MESSAGE,
      text
    });
  }
}

/**
 * 创建 create model prompt 相关数据。
 *
 * @param {unknown} context - context 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createModelPrompt(context) {
  return {
    input: context.input,
    inputText: context.inputText(),
    threadId: context.threadId,
    workingDirectory: context.workingDirectory,
    metadata: {
      ...(context.metadata ?? {}),
      doneCriteria: context.doneCriteria ?? []
    },
    tools: context.tools ?? [],
    parallelToolCalls: false,
    outputSchema: null,
    memories: context.memories ?? [],
    memoryContextText: context.memoryContextText ?? "",
    doneCriteria: context.doneCriteria ?? [],
    doneCriteriaText: context.doneCriteriaText ?? "",
    responseInputItems: context.responseInputItems ?? []
  };
}

/**
 * 创建 create model response item 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createModelResponseItem(options = {}) {
  const type = options.type ?? MODEL_RESPONSE_ITEM_TYPES.ASSISTANT_MESSAGE;
  const responseType = normalizeModelResponseItemType(type);

  if (responseType === RESPONSE_ITEM_TYPES.MESSAGE) {
    return {
      ...createResponseMessageItem({
        id: options.id,
        role: options.role ?? "assistant",
        text: options.text ?? "",
        content: options.content,
        phase: options.phase
      }),
      type: MODEL_RESPONSE_ITEM_TYPES.ASSISTANT_MESSAGE,
      text: String(options.text ?? ""),
      raw: options.raw ?? null
    };
  }

  if (responseType === RESPONSE_ITEM_TYPES.REASONING) {
    return {
      ...createResponseReasoningItem(options),
      type: MODEL_RESPONSE_ITEM_TYPES.REASONING,
      text: String(options.text ?? ""),
      raw: options.raw ?? null
    };
  }

  if (type === MODEL_RESPONSE_ITEM_TYPES.TOOL_CALL) {
    return {
      id: options.id ?? null,
      type: MODEL_RESPONSE_ITEM_TYPES.TOOL_CALL,
      text: String(options.text ?? ""),
      call_id: String(options.callId ?? options.call_id ?? options.id ?? ""),
      name: String(options.name ?? ""),
      arguments: options.arguments ?? {},
      raw: options.raw ?? null
    };
  }

  if (responseType === RESPONSE_ITEM_TYPES.FUNCTION_CALL) {
    return {
      ...createResponseFunctionCallItem(options),
      type: MODEL_RESPONSE_ITEM_TYPES.TOOL_CALL,
      raw: options.raw ?? null
    };
  }

  if (responseType === RESPONSE_ITEM_TYPES.CUSTOM_TOOL_CALL) {
    const item = createResponseCustomToolCallItem(options);

    return {
      id: item.id ?? null,
      type: MODEL_RESPONSE_ITEM_TYPES.TOOL_CALL,
      call_id: item.call_id,
      name: item.name,
      arguments: item.input,
      custom: true,
      raw: options.raw ?? null
    };
  }

  const item = {
    id: options.id ?? null,
    type,
    text: String(options.text ?? ""),
    raw: options.raw ?? null
  };

  if (type === MODEL_RESPONSE_ITEM_TYPES.TOOL_CALL) {
    item.call_id = String(options.callId ?? options.call_id ?? options.id ?? "");
    item.name = String(options.name ?? "");
    item.arguments = options.arguments ?? {};
  }

  return item;
}

/**
 * 创建 create scripted model client 相关数据。
 *
 * @param {unknown} script - script 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createScriptedModelClient(script) {
  return new MockModelClient({
    script
  });
}

/**
 * 创建 create scripted model response 相关数据。
 *
 * @param {unknown} items - items 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createScriptedModelResponse(items) {
  return (Array.isArray(items) ? items : [items]).map((item) => (
    item && typeof item === "object" ? createModelResponseItem(item) : item
  ));
}

/**
 * 归一化 normalize scripted model responses 相关数据。
 *
 * @param {unknown} script - script 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeScriptedModelResponses(script) {
  if (script == null) {
    return [];
  }

  return (Array.isArray(script) ? script : [script]).map(createScriptedModelResponse);
}

/**
 * 处理 response items for script turn 相关逻辑。
 *
 * @param {unknown} scriptedResponses - scriptedResponses 参数。
 * @param {unknown} turnIndex - turnIndex 参数。
 * @param {unknown} prompt - prompt 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function responseItemsForScriptTurn(scriptedResponses, turnIndex, prompt) {
  return scriptedResponses[turnIndex] ?? [
    createModelResponseItem({
      type: MODEL_RESPONSE_ITEM_TYPES.ASSISTANT_MESSAGE,
      text: defaultMockResponse(prompt.inputText)
    })
  ];
}

/**
 * 处理 model prompt to json 相关逻辑。
 *
 * @param {unknown} prompt - prompt 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function modelPromptToJSON(prompt) {
  return {
    ...prompt,
    memories: Array.isArray(prompt?.memories) ? [...prompt.memories] : [],
    memoryContextText: prompt?.memoryContextText ?? "",
    doneCriteria: Array.isArray(prompt?.doneCriteria) ? [...prompt.doneCriteria] : [],
    doneCriteriaText: prompt?.doneCriteriaText ?? "",
    responseInputItems: Array.isArray(prompt?.responseInputItems)
      ? [...prompt.responseInputItems]
      : []
  };
}

/**
 * 判断是否为 is tool call model response item 相关数据。
 *
 * @param {unknown} item - item 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function isToolCallModelResponseItem(item) {
  return item?.type === MODEL_RESPONSE_ITEM_TYPES.TOOL_CALL;
}

/**
 * 判断是否为 is assistant model response item 相关数据。
 *
 * @param {unknown} item - item 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function isAssistantModelResponseItem(item) {
  return item?.type === MODEL_RESPONSE_ITEM_TYPES.ASSISTANT_MESSAGE;
}

/**
 * 判断是否为 is reasoning model response item 相关数据。
 *
 * @param {unknown} item - item 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function isReasoningModelResponseItem(item) {
  return item?.type === MODEL_RESPONSE_ITEM_TYPES.REASONING;
}

/**
 * 归一化 normalize model response item type 相关数据。
 *
 * @param {unknown} type - type 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeModelResponseItemType(type) {
  switch (type) {
    case MODEL_RESPONSE_ITEM_TYPES.ASSISTANT_MESSAGE:
      return RESPONSE_ITEM_TYPES.MESSAGE;
    case MODEL_RESPONSE_ITEM_TYPES.REASONING:
      return RESPONSE_ITEM_TYPES.REASONING;
    case MODEL_RESPONSE_ITEM_TYPES.TOOL_CALL:
    case MODEL_RESPONSE_ITEM_TYPES.FUNCTION_CALL:
      return RESPONSE_ITEM_TYPES.FUNCTION_CALL;
    case MODEL_RESPONSE_ITEM_TYPES.CUSTOM_TOOL_CALL:
      return RESPONSE_ITEM_TYPES.CUSTOM_TOOL_CALL;
    default:
      return type;
  }
}

/**
 * 处理 default mock response 相关逻辑。
 *
 * @param {unknown} promptText - promptText 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function defaultMockResponse(promptText) {
  const trimmed = String(promptText ?? "").trim();
  const suffix = trimmed ? `: ${trimmed}` : ".";
  return `codex-js mock response${suffix}`;
}
