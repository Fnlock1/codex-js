/**
 * 中文模块说明：src/protocol/ids.js
 *
 * thread、turn、item、user input、permission 等公共协议对象。
 */
import { randomUUID } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 创建 create thread id 相关数据。
 * @returns {unknown} 返回处理后的结果。
 */
export function createThreadId() {
  return randomUUID();
}

/**
 * 创建 create session id 相关数据。
 * @returns {unknown} 返回处理后的结果。
 */
export function createSessionId() {
  return randomUUID();
}

/**
 * 处理 session id from thread id 相关逻辑。
 *
 * @param {unknown} threadId - threadId 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function sessionIdFromThreadId(threadId) {
  return parseThreadId(threadId);
}

/**
 * 处理 thread id from session id 相关逻辑。
 *
 * @param {unknown} sessionId - sessionId 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function threadIdFromSessionId(sessionId) {
  return parseSessionId(sessionId);
}

/**
 * 解析 parse thread id 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function parseThreadId(value) {
  return parseUuidString(value, "ThreadId");
}

/**
 * 解析 parse session id 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function parseSessionId(value) {
  return parseUuidString(value, "SessionId");
}

/**
 * 判断是否为 is thread id 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function isThreadId(value) {
  return isUuidString(value);
}

/**
 * 判断是否为 is session id 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function isSessionId(value) {
  return isUuidString(value);
}

/**
 * 解析 parse uuid string 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @param {unknown} label - label 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function parseUuidString(value, label) {
  if (!isUuidString(value)) {
    throw new TypeError(`${label} must be a UUID string.`);
  }

  return value.toLowerCase();
}

/**
 * 判断是否为 is uuid string 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function isUuidString(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
