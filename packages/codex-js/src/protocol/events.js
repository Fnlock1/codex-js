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

export function createThreadStartedEvent(threadId) {
  return {
    type: EVENT_TYPES.THREAD_STARTED,
    thread_id: threadId
  };
}

export function createTurnStartedEvent() {
  return {
    type: EVENT_TYPES.TURN_STARTED
  };
}

export function createTurnCompletedEvent(usage = emptyUsage()) {
  return {
    type: EVENT_TYPES.TURN_COMPLETED,
    usage
  };
}

export function createTurnFailedEvent(error) {
  return {
    type: EVENT_TYPES.TURN_FAILED,
    error: normalizeError(error)
  };
}

export function createItemStartedEvent(item) {
  return {
    type: EVENT_TYPES.ITEM_STARTED,
    item
  };
}

export function createItemUpdatedEvent(item) {
  return {
    type: EVENT_TYPES.ITEM_UPDATED,
    item
  };
}

export function createItemCompletedEvent(item) {
  return {
    type: EVENT_TYPES.ITEM_COMPLETED,
    item
  };
}

export function createErrorEvent(error) {
  return {
    type: EVENT_TYPES.ERROR,
    message: normalizeError(error).message
  };
}

export function emptyUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0
  };
}

export function isThreadEvent(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    Object.values(EVENT_TYPES).includes(value.type)
  );
}

export function normalizeError(error) {
  if (error && typeof error.message === "string") {
    return {
      message: error.message
    };
  }

  return {
    message: String(error)
  };
}
