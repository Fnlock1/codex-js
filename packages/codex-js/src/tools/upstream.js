import {
  CONTENT_ITEM_TYPES,
  createResponseCustomToolCallOutputItem,
  createResponseFunctionCallOutputItem,
  functionCallOutputPayloadToText
} from "../protocol/model-items.js";

export const UPSTREAM_TOOL_SPEC_TYPES = Object.freeze({
  FUNCTION: "function",
  NAMESPACE: "namespace",
  TOOL_SEARCH: "tool_search",
  IMAGE_GENERATION: "image_generation",
  WEB_SEARCH: "web_search",
  CUSTOM: "custom"
});

export const UPSTREAM_TOOL_PAYLOAD_TYPES = Object.freeze({
  FUNCTION: "function",
  TOOL_SEARCH: "tool_search",
  CUSTOM: "custom"
});

export const TOOL_OUTPUT_PREVIEW_LIMITS = Object.freeze({
  MAX_BYTES: 2 * 1024,
  MAX_LINES: 64,
  TRUNCATION_NOTICE: "[... telemetry preview truncated ...]"
});

export function createUpstreamToolDefinition(options = {}) {
  return {
    name: String(options.name ?? ""),
    description: String(options.description ?? ""),
    input_schema: normalizeJsonSchema(options.inputSchema ?? options.input_schema),
    output_schema: options.outputSchema ?? options.output_schema ?? null,
    defer_loading: Boolean(options.deferLoading ?? options.defer_loading ?? false)
  };
}

export function renameUpstreamToolDefinition(definition, name) {
  return {
    ...createUpstreamToolDefinition(definition),
    name: String(name ?? "")
  };
}

export function deferUpstreamToolDefinition(definition) {
  return {
    ...createUpstreamToolDefinition(definition),
    output_schema: null,
    defer_loading: true
  };
}

export function createUpstreamToolSpec(options = {}) {
  const type = options.type ?? UPSTREAM_TOOL_SPEC_TYPES.FUNCTION;

  switch (type) {
    case UPSTREAM_TOOL_SPEC_TYPES.FUNCTION:
      return omitNullish({
        type,
        name: String(options.name ?? ""),
        description: String(options.description ?? ""),
        parameters: normalizeJsonSchema(options.parameters ?? options.inputSchema ?? options.input_schema),
        strict: Boolean(options.strict ?? false)
      });
    case UPSTREAM_TOOL_SPEC_TYPES.NAMESPACE:
      return omitNullish({
        type,
        name: String(options.name ?? ""),
        description: String(options.description ?? ""),
        tools: Array.isArray(options.tools) ? options.tools.map(normalizeUpstreamToolSpec) : []
      });
    case UPSTREAM_TOOL_SPEC_TYPES.TOOL_SEARCH:
      return {
        type,
        execution: String(options.execution ?? "client"),
        description: String(options.description ?? ""),
        parameters: normalizeJsonSchema(options.parameters)
      };
    case UPSTREAM_TOOL_SPEC_TYPES.IMAGE_GENERATION:
      return {
        type,
        output_format: String(options.outputFormat ?? options.output_format ?? "png")
      };
    case UPSTREAM_TOOL_SPEC_TYPES.WEB_SEARCH:
      return omitNullish({
        type,
        external_web_access: normalizeOptionalBoolean(options.externalWebAccess ?? options.external_web_access),
        filters: options.filters ?? null,
        user_location: options.userLocation ?? options.user_location ?? null,
        search_context_size: options.searchContextSize ?? options.search_context_size ?? null,
        search_content_types: options.searchContentTypes ?? options.search_content_types ?? null
      });
    case UPSTREAM_TOOL_SPEC_TYPES.CUSTOM:
      return omitNullish({
        type,
        name: String(options.name ?? ""),
        description: String(options.description ?? ""),
        input_format: options.inputFormat ?? options.input_format ?? null
      });
    default:
      return {
        ...options,
        type
      };
  }
}

export function normalizeUpstreamToolSpec(spec = {}) {
  if (!spec || typeof spec !== "object") {
    throw new TypeError("Tool spec must be an object.");
  }

  return createUpstreamToolSpec(spec);
}

export function upstreamToolSpecName(spec = {}) {
  const normalized = normalizeUpstreamToolSpec(spec);

  switch (normalized.type) {
    case UPSTREAM_TOOL_SPEC_TYPES.TOOL_SEARCH:
      return "tool_search";
    case UPSTREAM_TOOL_SPEC_TYPES.IMAGE_GENERATION:
      return "image_generation";
    case UPSTREAM_TOOL_SPEC_TYPES.WEB_SEARCH:
      return "web_search";
    default:
      return String(normalized.name ?? "");
  }
}

export function createToolsJsonForResponsesApi(tools = []) {
  return tools.map(normalizeUpstreamToolSpec);
}

export function toolDefinitionToUpstreamToolSpec(definition) {
  const normalized = createUpstreamToolDefinition(definition);

  return createUpstreamToolSpec({
    type: UPSTREAM_TOOL_SPEC_TYPES.FUNCTION,
    name: normalized.name,
    description: normalized.description,
    parameters: normalized.input_schema
  });
}

export function createFunctionToolPayload(argumentsValue = {}) {
  return {
    type: UPSTREAM_TOOL_PAYLOAD_TYPES.FUNCTION,
    arguments: typeof argumentsValue === "string"
      ? argumentsValue
      : JSON.stringify(argumentsValue ?? {})
  };
}

export function createToolSearchPayload(argumentsValue = {}) {
  return {
    type: UPSTREAM_TOOL_PAYLOAD_TYPES.TOOL_SEARCH,
    arguments: {
      ...argumentsValue,
      query: String(argumentsValue?.query ?? "")
    }
  };
}

export function createCustomToolPayload(input = "") {
  return {
    type: UPSTREAM_TOOL_PAYLOAD_TYPES.CUSTOM,
    input: String(input ?? "")
  };
}

export function normalizeToolPayload(payload = {}) {
  if (typeof payload === "string") {
    return createCustomToolPayload(payload);
  }

  switch (payload.type) {
    case UPSTREAM_TOOL_PAYLOAD_TYPES.FUNCTION:
      return createFunctionToolPayload(payload.arguments);
    case UPSTREAM_TOOL_PAYLOAD_TYPES.TOOL_SEARCH:
      return createToolSearchPayload(payload.arguments);
    case UPSTREAM_TOOL_PAYLOAD_TYPES.CUSTOM:
      return createCustomToolPayload(payload.input);
    default:
      if ("input" in payload) {
        return createCustomToolPayload(payload.input);
      }

      return createFunctionToolPayload(payload.arguments ?? payload);
  }
}

export function toolPayloadLogPayload(payload = {}) {
  const normalized = normalizeToolPayload(payload);

  switch (normalized.type) {
    case UPSTREAM_TOOL_PAYLOAD_TYPES.TOOL_SEARCH:
      return normalized.arguments.query;
    case UPSTREAM_TOOL_PAYLOAD_TYPES.CUSTOM:
      return normalized.input;
    case UPSTREAM_TOOL_PAYLOAD_TYPES.FUNCTION:
    default:
      return normalized.arguments;
  }
}

export function createJsonToolOutput(value, options = {}) {
  return {
    kind: "json",
    value: value ?? null,
    success: options.success ?? true
  };
}

export function createTextToolOutput(text, options = {}) {
  return {
    kind: "text",
    value: String(text ?? ""),
    success: options.success ?? true
  };
}

export function normalizeToolOutput(output = {}) {
  if (typeof output === "string") {
    return createTextToolOutput(output);
  }

  if (!output || typeof output !== "object") {
    return createJsonToolOutput(output);
  }

  if (output.kind === "json" || output.kind === "text" || output.kind === "mcp") {
    return {
      ...output,
      success: output.success ?? true
    };
  }

  if ("output" in output || "status" in output || "error" in output) {
    return createTextToolOutput(output.output ?? "", {
      success: output.success ?? output.status !== "failed"
    });
  }

  return createJsonToolOutput(output, {
    success: output.success
  });
}

export function toolOutputLogPreview(output = {}, options = {}) {
  const normalized = normalizeToolOutput(output);
  const text = normalized.kind === "json"
    ? JSON.stringify(normalized.value)
    : String(normalized.value ?? "");

  return telemetryPreview(text, options);
}

export function toolOutputSuccessForLogging(output = {}) {
  return Boolean(normalizeToolOutput(output).success ?? true);
}

export function toolOutputToResponseItem(output, callId, payload = {}) {
  const normalizedOutput = normalizeToolOutput(output);
  const normalizedPayload = normalizeToolPayload(payload);
  const value = normalizedOutput.kind === "json"
    ? JSON.stringify(normalizedOutput.value)
    : String(normalizedOutput.value ?? "");

  if (normalizedPayload.type === UPSTREAM_TOOL_PAYLOAD_TYPES.CUSTOM) {
    return createResponseCustomToolCallOutputItem({
      callId,
      output: value,
      success: normalizedOutput.success
    });
  }

  return createResponseFunctionCallOutputItem({
    callId,
    output: value,
    success: normalizedOutput.success
  });
}

export function toolOutputPostToolUseId(_output, callId) {
  return String(callId ?? "");
}

export function toolOutputPostToolUseInput(_output, payload = {}) {
  const normalized = normalizeToolPayload(payload);

  if (normalized.type !== UPSTREAM_TOOL_PAYLOAD_TYPES.FUNCTION) {
    return null;
  }

  try {
    return JSON.parse(normalized.arguments);
  } catch {
    return null;
  }
}

export function toolOutputPostToolUseResponse(output = {}) {
  const normalized = normalizeToolOutput(output);

  if (normalized.kind === "json") {
    return normalized.value;
  }

  return null;
}

export function toolOutputCodeModeResult(output, payload = {}) {
  const responseItem = toolOutputToResponseItem(output, "", payload);

  if (
    responseItem.type === "function_call_output" ||
    responseItem.type === "custom_tool_call_output"
  ) {
    const body = responseItem.output?.body ?? responseItem.output;

    if (typeof body === "string") {
      return body;
    }

    return contentItemsToCodeModeResult(body);
  }

  return responseItemToCodeModeResult(responseItem);
}

export function responseItemToCodeModeResult(responseItem = {}) {
  if (responseItem.type === "message") {
    return contentItemsToCodeModeResult(responseItem.content);
  }

  if (
    responseItem.type === "function_call_output" ||
    responseItem.type === "custom_tool_call_output" ||
    responseItem.type === "tool_search_output"
  ) {
    return functionCallOutputPayloadToText(responseItem.output);
  }

  if (responseItem.type === "mcp_tool_call_output") {
    return responseItem.output ?? null;
  }

  return "";
}

export function telemetryPreview(content, options = {}) {
  const maxBytes = options.maxBytes ?? TOOL_OUTPUT_PREVIEW_LIMITS.MAX_BYTES;
  const maxLines = options.maxLines ?? TOOL_OUTPUT_PREVIEW_LIMITS.MAX_LINES;
  const notice = options.truncationNotice ?? TOOL_OUTPUT_PREVIEW_LIMITS.TRUNCATION_NOTICE;
  const text = String(content ?? "");
  const byBytes = takeUtf8BytesAtCharBoundary(text, maxBytes);
  const lines = byBytes.split(/\r?\n/u);
  const truncatedByBytes = byBytes.length < text.length;
  const truncatedByLines = lines.length > maxLines;
  const preview = lines.slice(0, maxLines).join("\n");

  if (!truncatedByBytes && !truncatedByLines) {
    return text;
  }

  return `${preview}${preview.endsWith("\n") || !preview ? "" : "\n"}${notice}`;
}

function contentItemsToCodeModeResult(items = []) {
  return asArray(items)
    .filter((item) => [
      CONTENT_ITEM_TYPES.INPUT_TEXT,
      CONTENT_ITEM_TYPES.OUTPUT_TEXT,
      CONTENT_ITEM_TYPES.TEXT
    ].includes(item?.type) && String(item.text ?? "").trim())
    .map((item) => item.text)
    .join("\n");
}

function normalizeJsonSchema(schema) {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return { ...schema };
  }

  return {
    type: "object",
    properties: {},
    additionalProperties: false
  };
}

function normalizeOptionalBoolean(value) {
  if (value == null) {
    return null;
  }

  return Boolean(value);
}

function takeUtf8BytesAtCharBoundary(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }

  let bytes = 0;
  let result = "";

  for (const char of text) {
    const charBytes = Buffer.byteLength(char, "utf8");

    if (bytes + charBytes > maxBytes) {
      break;
    }

    bytes += charBytes;
    result += char;
  }

  return result;
}

function asArray(value) {
  if (value == null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function omitNullish(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value != null)
  );
}
