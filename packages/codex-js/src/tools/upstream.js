/**
 * 中文模块说明：src/tools/upstream.js
 *
 * 工具定义、路由、handler、内置工具和上游工具格式转换。
 */
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

/**
 * 创建 create upstream tool definition 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createUpstreamToolDefinition(options = {}) {
  return {
    name: String(options.name ?? ""),
    description: String(options.description ?? ""),
    input_schema: normalizeJsonSchema(options.inputSchema ?? options.input_schema),
    output_schema: options.outputSchema ?? options.output_schema ?? null,
    defer_loading: Boolean(options.deferLoading ?? options.defer_loading ?? false)
  };
}

/**
 * 处理 rename upstream tool definition 相关逻辑。
 *
 * @param {unknown} definition - definition 参数。
 * @param {unknown} name - name 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function renameUpstreamToolDefinition(definition, name) {
  return {
    ...createUpstreamToolDefinition(definition),
    name: String(name ?? "")
  };
}

/**
 * 处理 defer upstream tool definition 相关逻辑。
 *
 * @param {unknown} definition - definition 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function deferUpstreamToolDefinition(definition) {
  return {
    ...createUpstreamToolDefinition(definition),
    output_schema: null,
    defer_loading: true
  };
}

/**
 * 创建 create upstream tool spec 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 归一化 normalize upstream tool spec 相关数据。
 *
 * @param {unknown} spec - spec 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeUpstreamToolSpec(spec = {}) {
  if (!spec || typeof spec !== "object") {
    throw new TypeError("Tool spec must be an object.");
  }

  return createUpstreamToolSpec(spec);
}

/**
 * 处理 upstream tool spec name 相关逻辑。
 *
 * @param {unknown} spec - spec 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 创建 create tools json for responses api 相关数据。
 *
 * @param {unknown} tools - tools 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createToolsJsonForResponsesApi(tools = []) {
  return tools.map(normalizeUpstreamToolSpec);
}

/**
 * 处理 tool definition to upstream tool spec 相关逻辑。
 *
 * @param {unknown} definition - definition 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function toolDefinitionToUpstreamToolSpec(definition) {
  const normalized = createUpstreamToolDefinition(definition);

  return createUpstreamToolSpec({
    type: UPSTREAM_TOOL_SPEC_TYPES.FUNCTION,
    name: normalized.name,
    description: normalized.description,
    parameters: normalized.input_schema
  });
}

/**
 * 创建 create function tool payload 相关数据。
 *
 * @param {unknown} argumentsValue - argumentsValue 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createFunctionToolPayload(argumentsValue = {}) {
  return {
    type: UPSTREAM_TOOL_PAYLOAD_TYPES.FUNCTION,
    arguments: typeof argumentsValue === "string"
      ? argumentsValue
      : JSON.stringify(argumentsValue ?? {})
  };
}

/**
 * 创建 create tool search payload 相关数据。
 *
 * @param {unknown} argumentsValue - argumentsValue 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createToolSearchPayload(argumentsValue = {}) {
  return {
    type: UPSTREAM_TOOL_PAYLOAD_TYPES.TOOL_SEARCH,
    arguments: {
      ...argumentsValue,
      query: String(argumentsValue?.query ?? "")
    }
  };
}

/**
 * 创建 create custom tool payload 相关数据。
 *
 * @param {unknown} input - input 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createCustomToolPayload(input = "") {
  return {
    type: UPSTREAM_TOOL_PAYLOAD_TYPES.CUSTOM,
    input: String(input ?? "")
  };
}

/**
 * 归一化 normalize tool payload 相关数据。
 *
 * @param {unknown} payload - payload 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 处理 tool payload log payload 相关逻辑。
 *
 * @param {unknown} payload - payload 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 创建 create json tool output 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createJsonToolOutput(value, options = {}) {
  return {
    kind: "json",
    value: value ?? null,
    success: options.success ?? true
  };
}

/**
 * 创建 create text tool output 相关数据。
 *
 * @param {unknown} text - text 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createTextToolOutput(text, options = {}) {
  return {
    kind: "text",
    value: String(text ?? ""),
    success: options.success ?? true
  };
}

/**
 * 归一化 normalize tool output 相关数据。
 *
 * @param {unknown} output - output 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 处理 tool output log preview 相关逻辑。
 *
 * @param {unknown} output - output 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function toolOutputLogPreview(output = {}, options = {}) {
  const normalized = normalizeToolOutput(output);
  const text = normalized.kind === "json"
    ? JSON.stringify(normalized.value)
    : String(normalized.value ?? "");

  return telemetryPreview(text, options);
}

/**
 * 处理 tool output success for logging 相关逻辑。
 *
 * @param {unknown} output - output 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function toolOutputSuccessForLogging(output = {}) {
  return Boolean(normalizeToolOutput(output).success ?? true);
}

/**
 * 处理 tool output to response item 相关逻辑。
 *
 * @param {unknown} output - output 参数。
 * @param {unknown} callId - callId 参数。
 * @param {unknown} payload - payload 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 处理 tool output post tool use id 相关逻辑。
 *
 * @param {unknown} _output - _output 参数。
 * @param {unknown} callId - callId 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function toolOutputPostToolUseId(_output, callId) {
  return String(callId ?? "");
}

/**
 * 处理 tool output post tool use input 相关逻辑。
 *
 * @param {unknown} _output - _output 参数。
 * @param {unknown} payload - payload 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 处理 tool output post tool use response 相关逻辑。
 *
 * @param {unknown} output - output 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function toolOutputPostToolUseResponse(output = {}) {
  const normalized = normalizeToolOutput(output);

  if (normalized.kind === "json") {
    return normalized.value;
  }

  return null;
}

/**
 * 处理 tool output code mode result 相关逻辑。
 *
 * @param {unknown} output - output 参数。
 * @param {unknown} payload - payload 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 处理 response item to code mode result 相关逻辑。
 *
 * @param {unknown} responseItem - responseItem 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 处理 telemetry preview 相关逻辑。
 *
 * @param {unknown} content - content 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 处理 content items to code mode result 相关逻辑。
 *
 * @param {unknown} items - items 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 归一化 normalize json schema 相关数据。
 *
 * @param {unknown} schema - schema 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 归一化 normalize optional boolean 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeOptionalBoolean(value) {
  if (value == null) {
    return null;
  }

  return Boolean(value);
}

/**
 * 处理 take utf8 bytes at char boundary 相关逻辑。
 *
 * @param {unknown} text - text 参数。
 * @param {unknown} maxBytes - maxBytes 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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
