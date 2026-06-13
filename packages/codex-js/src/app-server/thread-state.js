/**
 * 中文模块说明：src/app-server/thread-state.js
 *
 * 面向 UI 或守护进程的 JSONL/RPC app-server 协议层。
 */
export const THREAD_STATUS_TYPES = Object.freeze({
  NOT_LOADED: "notLoaded",
  IDLE: "idle",
  SYSTEM_ERROR: "systemError",
  ACTIVE: "active"
});

export const THREAD_ACTIVE_FLAGS = Object.freeze({
  WAITING_ON_APPROVAL: "waitingOnApproval",
  WAITING_ON_USER_INPUT: "waitingOnUserInput"
});

export const TURN_CONTROL_STATUSES = Object.freeze({
  ACTIVE: "active",
  COMPLETED: "completed",
  FAILED: "failed",
  INTERRUPTED: "interrupted"
});

/**
 * 创建 create thread status 相关数据。
 *
 * @param {unknown} type - type 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createThreadStatus(type, options = {}) {
  switch (type) {
    case THREAD_STATUS_TYPES.NOT_LOADED:
      return {
        type: THREAD_STATUS_TYPES.NOT_LOADED
      };
    case THREAD_STATUS_TYPES.SYSTEM_ERROR:
      return {
        type: THREAD_STATUS_TYPES.SYSTEM_ERROR,
        error: options.error ?? null
      };
    case THREAD_STATUS_TYPES.ACTIVE:
      return {
        type: THREAD_STATUS_TYPES.ACTIVE,
        activeFlags: Array.isArray(options.activeFlags)
          ? [...options.activeFlags]
          : []
      };
    case THREAD_STATUS_TYPES.IDLE:
    default:
      return {
        type: THREAD_STATUS_TYPES.IDLE
      };
  }
}

/**
 * 创建 create loaded thread entry 相关数据。
 *
 * @param {unknown} thread - thread 参数。
 * @param {unknown} session - session 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createLoadedThreadEntry(thread, session = null, options = {}) {
  return {
    threadId: thread.id,
    sessionId: thread.id,
    cwd: thread.workingDirectory,
    name: session?.metadata?.name ?? null,
    status: options.status ?? createThreadStatus(THREAD_STATUS_TYPES.IDLE),
    archived: Boolean(session?.archived ?? false),
    updatedAt: session?.updatedAt ?? null
  };
}

/**
 * 归一化 normalize thread name 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeThreadName(value) {
  const name = String(value ?? "").trim();

  if (!name) {
    return null;
  }

  return name.slice(0, 200);
}

/**
 * 创建 create turn control record 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createTurnControlRecord(options = {}) {
  return {
    turnId: String(options.turnId ?? ""),
    threadId: String(options.threadId ?? ""),
    status: options.status ?? TURN_CONTROL_STATUSES.ACTIVE,
    input: options.input ?? "",
    startedAtMs: options.startedAtMs ?? Date.now(),
    completedAtMs: options.completedAtMs ?? null,
    steerMessages: Array.isArray(options.steerMessages) ? [...options.steerMessages] : [],
    interruptRequested: Boolean(options.interruptRequested ?? false)
  };
}

/**
 * 创建 create steer message 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createSteerMessage(options = {}) {
  return {
    id: options.id,
    clientId: options.clientId ?? options.client_id ?? null,
    input: options.input ?? options.prompt ?? "",
    createdAtMs: options.createdAtMs ?? Date.now()
  };
}
