/**
 * 中文模块说明：src/mcp/protocol.js
 *
 * MCP 客户端、stdio 连接、协议转换和运行时封装。
 */
export const MCP_CONTENT_TYPES = Object.freeze({
  TEXT: "text",
  IMAGE: "image",
  RESOURCE: "resource"
});

export const MCP_ERRORS = Object.freeze({
  NOT_CONNECTED: "mcp_not_connected",
  START_BLOCKED: "mcp_start_blocked",
  START_FAILED: "mcp_start_failed",
  PROTOCOL_ERROR: "mcp_protocol_error",
  SERVER_NOT_FOUND: "mcp_server_not_found",
  TOOL_NOT_FOUND: "mcp_tool_not_found",
  RESOURCE_NOT_FOUND: "mcp_resource_not_found"
});

const MCP_TOOL_NAME_PREFIX = "mcp__";
const MCP_TOOL_NAME_DELIMITER = "__";

/**
 * 归一化 normalize mcp server info 相关数据。
 *
 * @param {unknown} info - info 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeMcpServerInfo(info = {}) {
  return {
    name: String(info.name ?? ""),
    title: info.title == null ? null : String(info.title),
    version: String(info.version ?? ""),
    description: info.description == null ? null : String(info.description),
    icons: Array.isArray(info.icons) ? info.icons : null,
    website_url: info.websiteUrl ?? info.website_url ?? null
  };
}

/**
 * 归一化 normalize mcp tool 相关数据。
 *
 * @param {unknown} tool - tool 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeMcpTool(tool = {}) {
  return {
    name: String(tool.name ?? ""),
    title: tool.title == null ? null : String(tool.title),
    description: tool.description == null ? null : String(tool.description),
    input_schema: tool.inputSchema ?? tool.input_schema ?? {
      type: "object",
      properties: {}
    },
    output_schema: tool.outputSchema ?? tool.output_schema ?? null,
    annotations: tool.annotations ?? null,
    icons: Array.isArray(tool.icons) ? tool.icons : null,
    _meta: tool._meta ?? tool.meta ?? null
  };
}

/**
 * 归一化 normalize mcp resource 相关数据。
 *
 * @param {unknown} resource - resource 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeMcpResource(resource = {}) {
  return {
    annotations: resource.annotations ?? null,
    description: resource.description == null ? null : String(resource.description),
    mime_type: resource.mimeType ?? resource.mime_type ?? null,
    name: String(resource.name ?? ""),
    size: normalizeOptionalInteger(resource.size),
    title: resource.title == null ? null : String(resource.title),
    uri: String(resource.uri ?? ""),
    icons: Array.isArray(resource.icons) ? resource.icons : null,
    _meta: resource._meta ?? resource.meta ?? null
  };
}

/**
 * 归一化 normalize mcp resource template 相关数据。
 *
 * @param {unknown} template - template 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeMcpResourceTemplate(template = {}) {
  return {
    annotations: template.annotations ?? null,
    uri_template: String(template.uriTemplate ?? template.uri_template ?? ""),
    name: String(template.name ?? ""),
    title: template.title == null ? null : String(template.title),
    description: template.description == null ? null : String(template.description),
    mime_type: template.mimeType ?? template.mime_type ?? null
  };
}

/**
 * 归一化 normalize mcp resource content 相关数据。
 *
 * @param {unknown} content - content 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeMcpResourceContent(content = {}) {
  const base = {
    uri: String(content.uri ?? ""),
    mime_type: content.mimeType ?? content.mime_type ?? null,
    _meta: content._meta ?? content.meta ?? null
  };

  if (content.blob != null) {
    return {
      ...base,
      blob: String(content.blob)
    };
  }

  return {
    ...base,
    text: String(content.text ?? "")
  };
}

/**
 * 创建 create mcp call tool result 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createMcpCallToolResult(options = {}) {
  return {
    content: Array.isArray(options.content) ? options.content : [],
    structured_content: options.structuredContent ?? options.structured_content ?? null,
    is_error: options.isError ?? options.is_error ?? null,
    _meta: options._meta ?? options.meta ?? null
  };
}

/**
 * 处理 mcp call tool result to text 相关逻辑。
 *
 * @param {unknown} result - result 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function mcpCallToolResultToText(result = {}) {
  const normalized = createMcpCallToolResult(result);
  const text = [];

  for (const item of normalized.content) {
    if (item?.type === MCP_CONTENT_TYPES.TEXT && item.text != null) {
      text.push(String(item.text));
    } else if (item?.text != null) {
      text.push(String(item.text));
    } else if (item != null) {
      text.push(JSON.stringify(item));
    }
  }

  if (normalized.structured_content != null) {
    text.push(JSON.stringify(normalized.structured_content));
  }

  return text.join("\n");
}

/**
 * 创建 create mcp text content 相关数据。
 *
 * @param {unknown} text - text 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createMcpTextContent(text) {
  return {
    type: MCP_CONTENT_TYPES.TEXT,
    text: String(text ?? "")
  };
}

/**
 * 创建 create mcp tool name 相关数据。
 *
 * @param {unknown} serverName - serverName 参数。
 * @param {unknown} toolName - toolName 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createMcpToolName(serverName, toolName) {
  const server = sanitizeMcpToolNamePart(serverName);
  const tool = sanitizeMcpToolNamePart(toolName);

  if (!server || !tool) {
    throw new Error("MCP server and tool names are required.");
  }

  return `${MCP_TOOL_NAME_PREFIX}${server}${MCP_TOOL_NAME_DELIMITER}${tool}`;
}

/**
 * 解析 parse mcp tool name 相关数据。
 *
 * @param {unknown} name - name 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function parseMcpToolName(name) {
  const value = String(name ?? "");

  if (!value.startsWith(MCP_TOOL_NAME_PREFIX)) {
    return null;
  }

  const parts = value.slice(MCP_TOOL_NAME_PREFIX.length).split(MCP_TOOL_NAME_DELIMITER);

  if (parts.length < 2 || !parts[0] || !parts.slice(1).join(MCP_TOOL_NAME_DELIMITER)) {
    return null;
  }

  return {
    server: parts[0],
    tool: parts.slice(1).join(MCP_TOOL_NAME_DELIMITER)
  };
}

/**
 * 创建 create mcp tool spec 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createMcpToolSpec(options = {}) {
  const server = String(options.server ?? "");
  const tool = normalizeMcpTool(options.tool ?? {});
  const name = options.name ?? createMcpToolName(server, tool.name);
  const descriptionParts = [
    tool.description,
    options.namespaceDescription
  ].filter(Boolean);

  return {
    type: "function",
    name,
    description: descriptionParts.join("\n\n"),
    strict: false,
    parameters: tool.input_schema,
    output_schema: tool.output_schema,
    mcp_server: server,
    mcp_tool: tool.name,
    annotations: tool.annotations,
    _meta: tool._meta
  };
}

/**
 * 处理 sanitize mcp tool name part 相关逻辑。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function sanitizeMcpToolNamePart(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * 归一化 normalize optional integer 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeOptionalInteger(value) {
  if (value == null) {
    return null;
  }

  const number = Number(value);

  if (!Number.isSafeInteger(number)) {
    return null;
  }

  return number;
}
