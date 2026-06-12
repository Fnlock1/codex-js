/**
 * 中文模块说明：src/protocol/events.js
 *
 * thread、turn、item、user input、permission 等公共协议对象。
 */
export const EVENT_TYPES = Object.freeze({
  THREAD_STARTED: "thread.started",
  TURN_STARTED: "turn.started",
  TURN_COMPLETED: "turn.completed",
  TURN_FAILED: "turn.failed",
  ITEM_STARTED: "item.started",
  ITEM_UPDATED: "item.updated",
  ITEM_COMPLETED: "item.completed",
  ERROR: "error"
});

/**
 * 创建 create thread started event 相关数据。
 *
 * @param {unknown} threadId - threadId 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createThreadStartedEvent(threadId) {
  return {
    type: EVENT_TYPES.THREAD_STARTED,
    thread_id: threadId
  };
}

/**
 * 创建 create turn started event 相关数据。
 * @returns {unknown} 返回处理后的结果。
 */
export function createTurnStartedEvent() {
  return {
    type: EVENT_TYPES.TURN_STARTED
  };
}

/**
 * 创建 create turn completed event 相关数据。
 *
 * @param {unknown} usage - usage 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createTurnCompletedEvent(usage = emptyUsage()) {
  return {
    type: EVENT_TYPES.TURN_COMPLETED,
    usage
  };
}

/**
 * 创建 create turn failed event 相关数据。
 *
 * @param {unknown} error - error 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createTurnFailedEvent(error) {
  return {
    type: EVENT_TYPES.TURN_FAILED,
    error: normalizeError(error)
  };
}

/**
 * 创建 create item started event 相关数据。
 *
 * @param {unknown} item - item 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createItemStartedEvent(item) {
  return {
    type: EVENT_TYPES.ITEM_STARTED,
    item
  };
}

/**
 * 创建 create item updated event 相关数据。
 *
 * @param {unknown} item - item 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createItemUpdatedEvent(item) {
  return {
    type: EVENT_TYPES.ITEM_UPDATED,
    item
  };
}

/**
 * 创建 create item completed event 相关数据。
 *
 * @param {unknown} item - item 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createItemCompletedEvent(item) {
  return {
    type: EVENT_TYPES.ITEM_COMPLETED,
    item
  };
}

/**
 * 创建 create error event 相关数据。
 *
 * @param {unknown} error - error 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createErrorEvent(error) {
  const normalized = normalizeError(error);

  return {
    type: EVENT_TYPES.ERROR,
    message: normalized.message,
    code: normalized.code ?? null,
    details: normalized.details ?? null
  };
}

/**
 * 处理 empty usage 相关逻辑。
 * @returns {unknown} 返回处理后的结果。
 */
export function emptyUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0
  };
}

/**
 * 判断是否为 is thread event 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function isThreadEvent(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    Object.values(EVENT_TYPES).includes(value.type)
  );
}

/**
 * 归一化 normalize error 相关数据。
 *
 * @param {unknown} error - error 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeError(error) {
  if (error && typeof error.message === "string") {
    const normalized = {
      message: error.message
    };

    if (error.code != null) {
      normalized.code = String(error.code);
    }

    if (error.details && typeof error.details === "object") {
      normalized.details = error.details;
    }

    return normalized;
  }

  return {
    message: String(error)
  };
}
