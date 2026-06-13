/**
 * 中文模块说明：src/protocol/items.js
 *
 * thread、turn、item、user input、permission 等公共协议对象。
 */
import { randomUUID } from "node:crypto";

export const ITEM_TYPES = Object.freeze({
  MESSAGE: "message",
  REASONING: "reasoning",
  COMMAND_EXECUTION: "command_execution",
  TOOL_CALL: "tool_call",
  TOOL_RESULT: "tool_result"
});

export const ITEM_STATUSES = Object.freeze({
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed"
});

export const MESSAGE_ROLES = Object.freeze({
  USER: "user",
  ASSISTANT: "assistant",
  SYSTEM: "system",
  TOOL: "tool"
});

/**
 * 创建 create user message item 相关数据。
 *
 * @param {unknown} text - text 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createUserMessageItem(text, options = {}) {
  return createMessageItem({
    id: options.id,
    role: MESSAGE_ROLES.USER,
    status: options.status ?? ITEM_STATUSES.COMPLETED,
    text
  });
}

/**
 * 创建 create assistant message item 相关数据。
 *
 * @param {unknown} text - text 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createAssistantMessageItem(text, options = {}) {
  return createMessageItem({
    id: options.id,
    role: MESSAGE_ROLES.ASSISTANT,
    status: options.status ?? ITEM_STATUSES.IN_PROGRESS,
    text
  });
}

/**
 * 创建 create message item 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createMessageItem({ id = randomUUID(), role, status, text }) {
  return {
    id,
    type: ITEM_TYPES.MESSAGE,
    role,
    status,
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

/**
 * 创建 create command execution item 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createCommandExecutionItem({
  id = randomUUID(),
  command,
  cwd,
  status = ITEM_STATUSES.IN_PROGRESS,
  output,
  approvalRequest = null
}) {
  const execOutput = output ?? null;

  return {
    id,
    type: ITEM_TYPES.COMMAND_EXECUTION,
    command: String(command ?? ""),
    cwd: cwd ? String(cwd) : null,
    aggregated_output: execOutput?.aggregated_output?.text ?? "",
    exit_code: execOutput?.exit_code ?? null,
    status,
    approval_request: approvalRequest
  };
}

/**
 * 创建 create reasoning item 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createReasoningItem({
  id = randomUUID(),
  summaryText,
  summary_text,
  rawContent,
  raw_content,
  status = ITEM_STATUSES.COMPLETED
}) {
  return {
    id,
    type: ITEM_TYPES.REASONING,
    summary_text: normalizeStringArray(summaryText ?? summary_text),
    raw_content: normalizeStringArray(rawContent ?? raw_content),
    status
  };
}

/**
 * 创建 create tool call item 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createToolCallItem({
  id = randomUUID(),
  callId,
  call_id,
  name,
  arguments: toolArguments,
  status = ITEM_STATUSES.IN_PROGRESS,
  output = null,
  error = null
}) {
  return {
    id,
    type: ITEM_TYPES.TOOL_CALL,
    call_id: String(callId ?? call_id ?? ""),
    name: String(name ?? ""),
    arguments: toolArguments ?? {},
    output,
    error,
    status
  };
}

/**
 * 创建 create tool result item 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createToolResultItem({
  id = randomUUID(),
  callId,
  call_id,
  name,
  status = ITEM_STATUSES.COMPLETED,
  output = "",
  error = null,
  responseInputItem,
  response_input_item
}) {
  return {
    id,
    type: ITEM_TYPES.TOOL_RESULT,
    call_id: String(callId ?? call_id ?? ""),
    name: String(name ?? ""),
    output: String(output ?? ""),
    error,
    response_input_item: responseInputItem ?? response_input_item ?? null,
    status
  };
}

/**
 * 获取 get item text 相关数据。
 *
 * @param {unknown} item - item 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function getItemText(item) {
  if (item?.type === ITEM_TYPES.COMMAND_EXECUTION) {
    return item.aggregated_output ?? "";
  }

  if (
    item?.type === ITEM_TYPES.TOOL_CALL ||
    item?.type === ITEM_TYPES.TOOL_RESULT
  ) {
    return item.output ?? "";
  }

  if (item?.type === ITEM_TYPES.REASONING) {
    return item.summary_text.join("\n");
  }

  return (item?.content ?? [])
    .filter((entry) => entry?.type === "text")
    .map((entry) => entry.text)
    .join("");
}

/**
 * 归一化 normalize string array 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeStringArray(value) {
  if (value == null) {
    return [];
  }

  return (Array.isArray(value) ? value : [value]).map((entry) => String(entry));
}

/**
 * 判断是否为 is thread item 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function isThreadItem(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    Object.values(ITEM_TYPES).includes(value.type)
  );
}
