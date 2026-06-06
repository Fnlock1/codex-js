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

export class ModelClient {
  createSession(_options = {}) {
    return new ModelClientSession();
  }
}

export class ModelClientSession {
  async *streamResponse(_prompt) {
    throw new Error("ModelClientSession.streamResponse() must be implemented by a subclass.");
  }
}

export class MockModelClient extends ModelClient {
  constructor(options = {}) {
    super();
    this.mockResponse = options.mockResponse;
    this.script = options.script ?? null;
    this.sessions = [];
  }

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

export class MockModelClientSession extends ModelClientSession {
  constructor(options = {}) {
    super();
    this.mockResponse = options.mockResponse;
    this.scriptedResponses = normalizeScriptedModelResponses(options.script);
    this.prompts = [];
    this.turnIndex = 0;
  }

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

export function createModelPrompt(context) {
  return {
    input: context.input,
    inputText: context.inputText(),
    threadId: context.threadId,
    workingDirectory: context.workingDirectory,
    metadata: context.metadata,
    tools: context.tools ?? [],
    parallelToolCalls: false,
    outputSchema: null,
    responseInputItems: context.responseInputItems ?? []
  };
}

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

export function createScriptedModelClient(script) {
  return new MockModelClient({
    script
  });
}

export function createScriptedModelResponse(items) {
  return (Array.isArray(items) ? items : [items]).map((item) => (
    item && typeof item === "object" ? createModelResponseItem(item) : item
  ));
}

export function normalizeScriptedModelResponses(script) {
  if (script == null) {
    return [];
  }

  return (Array.isArray(script) ? script : [script]).map(createScriptedModelResponse);
}

export function responseItemsForScriptTurn(scriptedResponses, turnIndex, prompt) {
  return scriptedResponses[turnIndex] ?? [
    createModelResponseItem({
      type: MODEL_RESPONSE_ITEM_TYPES.ASSISTANT_MESSAGE,
      text: defaultMockResponse(prompt.inputText)
    })
  ];
}

export function modelPromptToJSON(prompt) {
  return {
    ...prompt,
    responseInputItems: Array.isArray(prompt?.responseInputItems)
      ? [...prompt.responseInputItems]
      : []
  };
}

export function isToolCallModelResponseItem(item) {
  return item?.type === MODEL_RESPONSE_ITEM_TYPES.TOOL_CALL;
}

export function isAssistantModelResponseItem(item) {
  return item?.type === MODEL_RESPONSE_ITEM_TYPES.ASSISTANT_MESSAGE;
}

export function isReasoningModelResponseItem(item) {
  return item?.type === MODEL_RESPONSE_ITEM_TYPES.REASONING;
}

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

export function defaultMockResponse(promptText) {
  const trimmed = String(promptText ?? "").trim();
  const suffix = trimmed ? `: ${trimmed}` : ".";
  return `codex-js mock response${suffix}`;
}
