/**
 * 中文模块说明：src/protocol/model-items.js
 *
 * thread、turn、item、user input、permission 等公共协议对象。
 */
export const RESPONSE_ITEM_TYPES = Object.freeze({
  MESSAGE: "message",
  REASONING: "reasoning",
  FUNCTION_CALL: "function_call",
  FUNCTION_CALL_OUTPUT: "function_call_output",
  CUSTOM_TOOL_CALL: "custom_tool_call",
  CUSTOM_TOOL_CALL_OUTPUT: "custom_tool_call_output",
  TOOL_SEARCH_CALL: "tool_search_call",
  TOOL_SEARCH_OUTPUT: "tool_search_output"
});

export const RESPONSE_INPUT_ITEM_TYPES = Object.freeze({
  MESSAGE: "message",
  FUNCTION_CALL_OUTPUT: "function_call_output",
  CUSTOM_TOOL_CALL_OUTPUT: "custom_tool_call_output",
  TOOL_SEARCH_OUTPUT: "tool_search_output"
});

export const CONTENT_ITEM_TYPES = Object.freeze({
  INPUT_TEXT: "input_text",
  INPUT_IMAGE: "input_image",
  OUTPUT_TEXT: "output_text",
  REASONING_TEXT: "reasoning_text",
  TEXT: "text",
  ENCRYPTED_CONTENT: "encrypted_content"
});

export const MESSAGE_PHASES = Object.freeze({
  COMMENTARY: "commentary",
  FINAL_ANSWER: "final_answer"
});

export const IMAGE_DETAILS = Object.freeze({
  AUTO: "auto",
  LOW: "low",
  HIGH: "high",
  ORIGINAL: "original"
});

/**
 * 创建 create response message item 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createResponseMessageItem(options = {}) {
  return omitNullish({
    id: options.id ?? null,
    type: RESPONSE_ITEM_TYPES.MESSAGE,
    role: String(options.role ?? "assistant"),
    content: normalizeContentItems(options.content ?? [
      createOutputTextContent(options.text ?? "")
    ]),
    phase: options.phase ?? null
  });
}

/**
 * 创建 create response input message item 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createResponseInputMessageItem(options = {}) {
  return omitNullish({
    id: options.id ?? null,
    type: RESPONSE_INPUT_ITEM_TYPES.MESSAGE,
    role: String(options.role ?? "user"),
    content: normalizeInputContentItems(options.content ?? [
      createInputTextContent(options.text ?? "")
    ])
  });
}

/**
 * 创建 create response reasoning item 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createResponseReasoningItem(options = {}) {
  return omitNullish({
    id: options.id ?? "",
    type: RESPONSE_ITEM_TYPES.REASONING,
    summary: normalizeReasoningSummary(options.summary ?? options.summaryText ?? []),
    content: normalizeReasoningContent(options.content ?? options.rawContent ?? []),
    encrypted_content: options.encryptedContent ?? options.encrypted_content ?? null
  });
}

/**
 * 创建 create response function call item 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createResponseFunctionCallItem(options = {}) {
  return omitNullish({
    id: options.id ?? null,
    type: RESPONSE_ITEM_TYPES.FUNCTION_CALL,
    name: String(options.name ?? ""),
    namespace: options.namespace ?? null,
    arguments: stringifyArguments(options.arguments),
    call_id: String(options.callId ?? options.call_id ?? options.id ?? "")
  });
}

/**
 * 创建 create response custom tool call item 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createResponseCustomToolCallItem(options = {}) {
  return omitNullish({
    id: options.id ?? null,
    type: RESPONSE_ITEM_TYPES.CUSTOM_TOOL_CALL,
    status: options.status ?? null,
    call_id: String(options.callId ?? options.call_id ?? options.id ?? ""),
    name: String(options.name ?? ""),
    input: String(options.input ?? "")
  });
}

/**
 * 创建 create response function call output item 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createResponseFunctionCallOutputItem(options = {}) {
  return {
    type: RESPONSE_ITEM_TYPES.FUNCTION_CALL_OUTPUT,
    call_id: String(options.callId ?? options.call_id ?? ""),
    output: createFunctionCallOutputPayload(options.output ?? "", {
      success: options.success
    })
  };
}

/**
 * 创建 create response custom tool call output item 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createResponseCustomToolCallOutputItem(options = {}) {
  return omitNullish({
    type: RESPONSE_ITEM_TYPES.CUSTOM_TOOL_CALL_OUTPUT,
    call_id: String(options.callId ?? options.call_id ?? ""),
    name: options.name == null ? null : String(options.name),
    output: createFunctionCallOutputPayload(options.output ?? "", {
      success: options.success
    })
  });
}

/**
 * 创建 create response tool call output item 相关数据。
 *
 * @param {unknown} toolCall - toolCall 参数。
 * @param {unknown} result - result 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createResponseToolCallOutputItem(toolCall, result = {}) {
  const output = result.output ?? "";
  const success = result.success ?? result.status !== "failed";
  const callId = toolCall?.call_id ?? toolCall?.callId ?? result.call_id ?? result.callId ?? "";
  const name = toolCall?.name ?? result.name ?? null;

  if (toolCall?.custom) {
    return createResponseCustomToolCallOutputItem({
      callId,
      name,
      output,
      success
    });
  }

  return createResponseFunctionCallOutputItem({
    callId,
    output,
    success
  });
}

/**
 * 创建 create input text content 相关数据。
 *
 * @param {unknown} text - text 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createInputTextContent(text) {
  return {
    type: CONTENT_ITEM_TYPES.INPUT_TEXT,
    text: String(text ?? "")
  };
}

/**
 * 创建 create output text content 相关数据。
 *
 * @param {unknown} text - text 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createOutputTextContent(text) {
  return {
    type: CONTENT_ITEM_TYPES.OUTPUT_TEXT,
    text: String(text ?? "")
  };
}

/**
 * 创建 create input image content 相关数据。
 *
 * @param {unknown} imageUrl - imageUrl 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createInputImageContent(imageUrl, options = {}) {
  return omitNullish({
    type: CONTENT_ITEM_TYPES.INPUT_IMAGE,
    image_url: String(imageUrl ?? ""),
    detail: options.detail ?? IMAGE_DETAILS.HIGH
  });
}

/**
 * 创建 create function call output payload 相关数据。
 *
 * @param {unknown} output - output 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createFunctionCallOutputPayload(output, options = {}) {
  const body = Array.isArray(output)
    ? output.map(normalizeFunctionCallOutputContentItem)
    : String(output ?? "");

  return {
    body,
    success: options.success ?? null
  };
}

/**
 * 处理 function call output payload to wire value 相关逻辑。
 *
 * @param {unknown} payload - payload 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function functionCallOutputPayloadToWireValue(payload) {
  const normalized = createFunctionCallOutputPayload(payload?.body ?? payload, {
    success: payload?.success
  });

  return normalized.body;
}

/**
 * 处理 function call output payload to text 相关逻辑。
 *
 * @param {unknown} payload - payload 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function functionCallOutputPayloadToText(payload) {
  const body = payload?.body ?? payload;

  if (typeof body === "string") {
    return body;
  }

  if (!Array.isArray(body)) {
    return "";
  }

  return body
    .filter((item) => item?.type === CONTENT_ITEM_TYPES.INPUT_TEXT && item.text.trim())
    .map((item) => item.text)
    .join("\n");
}

/**
 * 归一化 normalize response item 相关数据。
 *
 * @param {unknown} item - item 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeResponseItem(item) {
  if (!item || typeof item !== "object") {
    throw new TypeError("Response item must be an object.");
  }

  switch (item.type) {
    case RESPONSE_ITEM_TYPES.MESSAGE:
      return createResponseMessageItem(item);
    case RESPONSE_ITEM_TYPES.REASONING:
      return createResponseReasoningItem(item);
    case RESPONSE_ITEM_TYPES.FUNCTION_CALL:
      return createResponseFunctionCallItem(item);
    case RESPONSE_ITEM_TYPES.CUSTOM_TOOL_CALL:
      return createResponseCustomToolCallItem(item);
    case RESPONSE_ITEM_TYPES.FUNCTION_CALL_OUTPUT:
      return createResponseFunctionCallOutputItem(item);
    case RESPONSE_ITEM_TYPES.CUSTOM_TOOL_CALL_OUTPUT:
      return createResponseCustomToolCallOutputItem(item);
    default:
      return { ...item };
  }
}

/**
 * 归一化 normalize response items 相关数据。
 *
 * @param {unknown} items - items 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeResponseItems(items) {
  return asArray(items).map(normalizeResponseItem);
}

/**
 * 处理 response item to text 相关逻辑。
 *
 * @param {unknown} item - item 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function responseItemToText(item) {
  if (!item || typeof item !== "object") {
    return "";
  }

  switch (item.type) {
    case RESPONSE_ITEM_TYPES.MESSAGE:
      return contentItemsToText(item.content, [
        CONTENT_ITEM_TYPES.OUTPUT_TEXT,
        CONTENT_ITEM_TYPES.INPUT_TEXT,
        CONTENT_ITEM_TYPES.TEXT
      ]);
    case RESPONSE_ITEM_TYPES.REASONING:
      return [
        contentItemsToText(item.summary, ["summary_text"]),
        contentItemsToText(item.content, [
          CONTENT_ITEM_TYPES.REASONING_TEXT,
          CONTENT_ITEM_TYPES.TEXT
        ])
      ].filter(Boolean).join("\n");
    case RESPONSE_ITEM_TYPES.FUNCTION_CALL_OUTPUT:
    case RESPONSE_ITEM_TYPES.CUSTOM_TOOL_CALL_OUTPUT:
    case RESPONSE_ITEM_TYPES.TOOL_SEARCH_OUTPUT:
      return functionCallOutputPayloadToText(item.output);
    default:
      return "";
  }
}

/**
 * 归一化 normalize content items 相关数据。
 *
 * @param {unknown} content - content 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeContentItems(content) {
  return asArray(content).map((item) => {
    if (typeof item === "string") {
      return createOutputTextContent(item);
    }

    return { ...item };
  });
}

/**
 * 归一化 normalize input content items 相关数据。
 *
 * @param {unknown} content - content 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeInputContentItems(content) {
  return asArray(content).map((item) => {
    if (typeof item === "string") {
      return createInputTextContent(item);
    }

    return { ...item };
  });
}

/**
 * 归一化 normalize reasoning summary 相关数据。
 *
 * @param {unknown} summary - summary 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeReasoningSummary(summary) {
  return asArray(summary).map((entry) => {
    if (typeof entry === "string") {
      return {
        type: "summary_text",
        text: entry
      };
    }

    return { ...entry };
  });
}

/**
 * 归一化 normalize reasoning content 相关数据。
 *
 * @param {unknown} content - content 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeReasoningContent(content) {
  return asArray(content).map((entry) => {
    if (typeof entry === "string") {
      return {
        type: CONTENT_ITEM_TYPES.REASONING_TEXT,
        text: entry
      };
    }

    return { ...entry };
  });
}

/**
 * 归一化 normalize function call output content item 相关数据。
 *
 * @param {unknown} item - item 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeFunctionCallOutputContentItem(item) {
  if (typeof item === "string") {
    return createInputTextContent(item);
  }

  return { ...item };
}

/**
 * 处理 stringify arguments 相关逻辑。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function stringifyArguments(value) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value ?? {});
}

/**
 * 处理 as array 相关逻辑。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function asArray(value) {
  if (value == null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

/**
 * 处理 content items to text 相关逻辑。
 *
 * @param {unknown} items - items 参数。
 * @param {unknown} allowedTypes - allowedTypes 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function contentItemsToText(items, allowedTypes) {
  return asArray(items)
    .filter((item) => allowedTypes.includes(item?.type) && String(item.text ?? "").trim())
    .map((item) => item.text)
    .join("\n");
}

/**
 * 处理 omit nullish 相关逻辑。
 *
 * @param {unknown} object - object 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function omitNullish(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value != null)
  );
}
