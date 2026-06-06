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

export function createResponseReasoningItem(options = {}) {
  return omitNullish({
    id: options.id ?? "",
    type: RESPONSE_ITEM_TYPES.REASONING,
    summary: normalizeReasoningSummary(options.summary ?? options.summaryText ?? []),
    content: normalizeReasoningContent(options.content ?? options.rawContent ?? []),
    encrypted_content: options.encryptedContent ?? options.encrypted_content ?? null
  });
}

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

export function createResponseFunctionCallOutputItem(options = {}) {
  return {
    type: RESPONSE_ITEM_TYPES.FUNCTION_CALL_OUTPUT,
    call_id: String(options.callId ?? options.call_id ?? ""),
    output: createFunctionCallOutputPayload(options.output ?? "", {
      success: options.success
    })
  };
}

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

export function createInputTextContent(text) {
  return {
    type: CONTENT_ITEM_TYPES.INPUT_TEXT,
    text: String(text ?? "")
  };
}

export function createOutputTextContent(text) {
  return {
    type: CONTENT_ITEM_TYPES.OUTPUT_TEXT,
    text: String(text ?? "")
  };
}

export function createInputImageContent(imageUrl, options = {}) {
  return omitNullish({
    type: CONTENT_ITEM_TYPES.INPUT_IMAGE,
    image_url: String(imageUrl ?? ""),
    detail: options.detail ?? IMAGE_DETAILS.HIGH
  });
}

export function createFunctionCallOutputPayload(output, options = {}) {
  const body = Array.isArray(output)
    ? output.map(normalizeFunctionCallOutputContentItem)
    : String(output ?? "");

  return {
    body,
    success: options.success ?? null
  };
}

export function functionCallOutputPayloadToWireValue(payload) {
  const normalized = createFunctionCallOutputPayload(payload?.body ?? payload, {
    success: payload?.success
  });

  return normalized.body;
}

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

export function normalizeResponseItems(items) {
  return asArray(items).map(normalizeResponseItem);
}

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

export function normalizeContentItems(content) {
  return asArray(content).map((item) => {
    if (typeof item === "string") {
      return createOutputTextContent(item);
    }

    return { ...item };
  });
}

export function normalizeInputContentItems(content) {
  return asArray(content).map((item) => {
    if (typeof item === "string") {
      return createInputTextContent(item);
    }

    return { ...item };
  });
}

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

export function normalizeFunctionCallOutputContentItem(item) {
  if (typeof item === "string") {
    return createInputTextContent(item);
  }

  return { ...item };
}

function stringifyArguments(value) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value ?? {});
}

function asArray(value) {
  if (value == null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function contentItemsToText(items, allowedTypes) {
  return asArray(items)
    .filter((item) => allowedTypes.includes(item?.type) && String(item.text ?? "").trim())
    .map((item) => item.text)
    .join("\n");
}

function omitNullish(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value != null)
  );
}
