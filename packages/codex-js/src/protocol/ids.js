import { randomUUID } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createThreadId() {
  return randomUUID();
}

export function createSessionId() {
  return randomUUID();
}

export function sessionIdFromThreadId(threadId) {
  return parseThreadId(threadId);
}

export function threadIdFromSessionId(sessionId) {
  return parseSessionId(sessionId);
}

export function parseThreadId(value) {
  return parseUuidString(value, "ThreadId");
}

export function parseSessionId(value) {
  return parseUuidString(value, "SessionId");
}

export function isThreadId(value) {
  return isUuidString(value);
}

export function isSessionId(value) {
  return isUuidString(value);
}

function parseUuidString(value, label) {
  if (!isUuidString(value)) {
    throw new TypeError(`${label} must be a UUID string.`);
  }

  return value.toLowerCase();
}

function isUuidString(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
