/**
 * 中文模块说明：src/app-server/protocol.js
 *
 * 面向 UI 或守护进程的 JSONL/RPC app-server 协议层。
 */
import {
  THREAD_STATUS_TYPES,
  createThreadStatus
} from "./thread-state.js";

export const APP_SERVER_METHODS = Object.freeze({
  INITIALIZE: "initialize",
  INITIALIZED: "initialized",
  THREAD_START: "thread/start",
  THREAD_RESUME: "thread/resume",
  THREAD_FORK: "thread/fork",
  THREAD_READ: "thread/read",
  THREAD_LIST: "thread/list",
  THREAD_LOADED_LIST: "thread/loaded/list",
  THREAD_TURNS_LIST: "thread/turns/list",
  THREAD_ARCHIVE: "thread/archive",
  THREAD_UNARCHIVE: "thread/unarchive",
  THREAD_UNSUBSCRIBE: "thread/unsubscribe",
  THREAD_INJECT_ITEMS: "thread/inject_items",
  THREAD_NAME_SET: "thread/name/set",
  THREAD_GOAL_SET: "thread/goal/set",
  THREAD_GOAL_GET: "thread/goal/get",
  THREAD_GOAL_CLEAR: "thread/goal/clear",
  THREAD_ROLLBACK: "thread/rollback",
  THREAD_METADATA_UPDATE: "thread/metadata/update",
  THREAD_SETTINGS_UPDATE: "thread/settings/update",
  THREAD_COMPACT_START: "thread/compact/start",
  TURN_START: "turn/start",
  TURN_STEER: "turn/steer",
  TURN_INTERRUPT: "turn/interrupt",
  COMMAND_EXEC: "command/exec",
  COMMAND_EXEC_WRITE: "command/exec/write",
  COMMAND_EXEC_TERMINATE: "command/exec/terminate",
  COMMAND_EXEC_RESIZE: "command/exec/resize",
  FS_READ_FILE: "fs/readFile",
  FS_WRITE_FILE: "fs/writeFile",
  FS_CREATE_DIRECTORY: "fs/createDirectory",
  FS_GET_METADATA: "fs/getMetadata",
  FS_READ_DIRECTORY: "fs/readDirectory",
  FS_REMOVE: "fs/remove",
  FS_COPY: "fs/copy",
  FS_WATCH: "fs/watch",
  FS_UNWATCH: "fs/unwatch",
  PROCESS_SPAWN: "process/spawn",
  PROCESS_WRITE_STDIN: "process/writeStdin",
  PROCESS_RESIZE_PTY: "process/resizePty",
  PROCESS_KILL: "process/kill",
  SERVER_REQUEST_LIST: "serverRequest/list",
  SERVER_REQUEST_RESOLVE: "serverRequest/resolve",
  PERMISSION_PROFILE_LIST: "permissionProfile/list",
  CONFIG_READ: "config/read",
  CONFIG_VALUE_WRITE: "config/value/write",
  CONFIG_BATCH_WRITE: "config/batchWrite",
  CONFIG_REQUIREMENTS_READ: "configRequirements/read",
  EXPERIMENTAL_FEATURE_LIST: "experimentalFeature/list",
  EXPERIMENTAL_FEATURE_ENABLEMENT_SET: "experimentalFeature/enablement/set",
  MCP_SERVER_STATUS_LIST: "mcpServerStatus/list",
  MCP_RESOURCE_READ: "mcpServer/resource/read",
  MCP_TOOL_CALL: "mcpServer/tool/call"
});

export const APP_SERVER_NOTIFICATIONS = Object.freeze({
  THREAD_STARTED: "thread/started",
  THREAD_ARCHIVED: "thread/archived",
  THREAD_UNARCHIVED: "thread/unarchived",
  THREAD_NAME_UPDATED: "thread/name/updated",
  THREAD_GOAL_UPDATED: "thread/goal/updated",
  THREAD_GOAL_CLEARED: "thread/goal/cleared",
  THREAD_STATUS_CHANGED: "thread/status/changed",
  THREAD_METADATA_UPDATED: "thread/metadata/updated",
  THREAD_COMPACTED: "thread/compacted",
  TURN_STARTED: "turn/started",
  TURN_COMPLETED: "turn/completed",
  TURN_FAILED: "turn/failed",
  ITEM_STARTED: "item/started",
  ITEM_UPDATED: "item/updated",
  ITEM_COMPLETED: "item/completed",
  COMMAND_EXEC_OUTPUT_DELTA: "command/exec/outputDelta",
  FS_CHANGED: "fs/changed",
  PROCESS_OUTPUT_DELTA: "process/outputDelta",
  PROCESS_EXITED: "process/exited",
  SERVER_REQUEST_RESOLVED: "serverRequest/resolved",
  ERROR: "error"
});

export const APP_SERVER_ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  NOT_INITIALIZED: -32002,
  ALREADY_INITIALIZED: -32003
});

/**
 * 创建 create rpc request 相关数据。
 *
 * @param {unknown} method - method 参数。
 * @param {unknown} params - params 参数。
 * @param {unknown} id - id 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createRpcRequest(method, params = {}, id = null) {
  return omitNullish({
    id,
    method: String(method ?? ""),
    params
  });
}

/**
 * 创建 create rpc notification 相关数据。
 *
 * @param {unknown} method - method 参数。
 * @param {unknown} params - params 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createRpcNotification(method, params = {}) {
  return {
    method: String(method ?? ""),
    params
  };
}

/**
 * 创建 create rpc success 相关数据。
 *
 * @param {unknown} id - id 参数。
 * @param {unknown} result - result 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createRpcSuccess(id, result = {}) {
  return {
    id,
    result
  };
}

/**
 * 创建 create rpc error 相关数据。
 *
 * @param {unknown} id - id 参数。
 * @param {unknown} code - code 参数。
 * @param {unknown} message - message 参数。
 * @param {unknown} data - data 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createRpcError(id, code, message, data = null) {
  return omitNullish({
    id,
    error: omitNullish({
      code,
      message: String(message ?? ""),
      data
    })
  });
}

/**
 * 归一化 normalize rpc message 相关数据。
 *
 * @param {unknown} message - message 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeRpcMessage(message) {
  if (!message || typeof message !== "object") {
    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_REQUEST,
      "JSON-RPC message must be an object."
    );
  }

  if (typeof message.method !== "string" || !message.method) {
    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_REQUEST,
      "JSON-RPC message method is required."
    );
  }

  return {
    id: message.id ?? null,
    method: message.method,
    params: message.params ?? {}
  };
}

/**
 * 创建 create thread view 相关数据。
 *
 * @param {unknown} thread - thread 参数。
 * @param {unknown} session - session 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createThreadView(thread, session = null, options = {}) {
  return {
    id: thread.id,
    sessionId: thread.id,
    cwd: thread.workingDirectory,
    name: session?.metadata?.name ?? null,
    path: session?.path ?? null,
    status: normalizeThreadStatus(options.status, {
      loaded: Boolean(options.loaded ?? true)
    }),
    archived: Boolean(session?.archived ?? options.archived),
    forkedFromId: session?.metadata?.forkedFromId ?? options.forkedFromId ?? null,
    ephemeral: Boolean(options.ephemeral ?? false),
    turns: options.includeTurns === false ? [] : session?.turns ?? [],
    createdAt: session?.createdAt ?? null,
    updatedAt: session?.updatedAt ?? null,
    metadata: session?.metadata ?? {}
  };
}

/**
 * 归一化 normalize thread status 相关数据。
 *
 * @param {unknown} status - status 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeThreadStatus(status, options = {}) {
  if (status && typeof status === "object" && typeof status.type === "string") {
    return status;
  }

  switch (status) {
    case "notLoaded":
      return createThreadStatus(THREAD_STATUS_TYPES.NOT_LOADED);
    case "systemError":
      return createThreadStatus(THREAD_STATUS_TYPES.SYSTEM_ERROR);
    case "active":
      return createThreadStatus(THREAD_STATUS_TYPES.ACTIVE, {
        activeFlags: options.activeFlags
      });
    case "loaded":
    case "idle":
    default:
      return options.loaded === false
        ? createThreadStatus(THREAD_STATUS_TYPES.NOT_LOADED)
        : createThreadStatus(THREAD_STATUS_TYPES.IDLE);
  }
}

/**
 * 处理 page turns 相关逻辑。
 *
 * @param {unknown} turns - turns 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function pageTurns(turns = [], options = {}) {
  const sortDirection = options.sortDirection === "asc" ? "asc" : "desc";
  const limit = clampLimit(options.limit ?? 50);
  const ordered = sortDirection === "asc" ? [...turns] : [...turns].reverse();
  const offset = decodeCursor(options.cursor);
  const page = ordered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;

  return {
    turns: page.map((turn, index) => createTurnView(turn, {
      index: sortDirection === "asc"
        ? offset + index
        : turns.length - 1 - (offset + index),
      itemsView: options.itemsView
    })),
    nextCursor: nextOffset < ordered.length ? encodeCursor(nextOffset) : null,
    backwardsCursor: offset > 0 ? encodeCursor(Math.max(0, offset - limit)) : null
  };
}

/**
 * 创建 create turn view 相关数据。
 *
 * @param {unknown} turn - turn 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createTurnView(turn = {}, options = {}) {
  const itemsView = options.itemsView ?? "full";

  return {
    id: turn.id ?? `turn-${options.index ?? 0}`,
    index: options.index ?? null,
    input: turn.input ?? "",
    status: turn.failed ? "failed" : "completed",
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
    items: itemsView === "none" ? [] : turn.items ?? [],
    eventCount: Array.isArray(turn.events) ? turn.events.length : 0
  };
}

/**
 * 创建 create command exec view 相关数据。
 *
 * @param {unknown} result - result 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createCommandExecView(result = {}) {
  return {
    status: result.error ? "failed" : "completed",
    exitCode: result.output?.exit_code ?? null,
    output: result.output?.aggregated_output?.text ?? "",
    error: result.error ?? null,
    dryRun: Boolean(result.dry_run)
  };
}

/**
 * 处理 thread event to app server notification 相关逻辑。
 *
 * @param {unknown} event - event 参数。
 * @param {unknown} threadId - threadId 参数。
 * @param {unknown} turnId - turnId 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function threadEventToAppServerNotification(event, threadId, turnId = null) {
  const base = {
    threadId,
    turnId
  };

  switch (event.type) {
    case "thread.started":
      return createRpcNotification(APP_SERVER_NOTIFICATIONS.THREAD_STARTED, {
        ...base,
        thread: event.thread ?? {
          id: event.thread_id ?? threadId
        }
      });
    case "turn.started":
      return createRpcNotification(APP_SERVER_NOTIFICATIONS.TURN_STARTED, {
        ...base
      });
    case "turn.completed":
      return createRpcNotification(APP_SERVER_NOTIFICATIONS.TURN_COMPLETED, {
        ...base,
        usage: event.usage ?? null
      });
    case "turn.failed":
      return createRpcNotification(APP_SERVER_NOTIFICATIONS.TURN_FAILED, {
        ...base,
        error: event.error ?? null
      });
    case "item.started":
      return createRpcNotification(APP_SERVER_NOTIFICATIONS.ITEM_STARTED, {
        ...base,
        item: event.item
      });
    case "item.updated":
      return createRpcNotification(APP_SERVER_NOTIFICATIONS.ITEM_UPDATED, {
        ...base,
        item: event.item
      });
    case "item.completed":
      return createRpcNotification(APP_SERVER_NOTIFICATIONS.ITEM_COMPLETED, {
        ...base,
        item: event.item
      });
    case "error":
      return createRpcNotification(APP_SERVER_NOTIFICATIONS.ERROR, {
        ...base,
        message: event.message
      });
    default:
      return null;
  }
}

/**
 * 创建 create app server protocol error 相关数据。
 *
 * @param {unknown} code - code 参数。
 * @param {unknown} message - message 参数。
 * @param {unknown} data - data 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createAppServerProtocolError(code, message, data = null) {
  const error = new Error(String(message ?? ""));
  error.code = code;
  error.data = data;

  return error;
}

/**
 * 处理 clamp limit 相关逻辑。
 *
 * @param {unknown} limit - limit 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function clampLimit(limit) {
  const number = Number(limit);

  if (!Number.isFinite(number) || number <= 0) {
    return 50;
  }

  return Math.min(Math.floor(number), 200);
}

/**
 * 编码 encode cursor 相关数据。
 *
 * @param {unknown} offset - offset 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({
    offset
  })).toString("base64url");
}

/**
 * 解码 decode cursor 相关数据。
 *
 * @param {unknown} cursor - cursor 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function decodeCursor(cursor) {
  if (!cursor) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    const offset = Number(parsed.offset);

    return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
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
