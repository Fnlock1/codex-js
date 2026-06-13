/**
 * 中文模块说明：src/runtime/mock-agent.js
 *
 * 轻量 mock runtime，用于测试和示例。
 */
import { MockTurnRuntime, defaultMockResponse } from "../core/turn-runtime.js";
import { userInputToText } from "../protocol/index.js";

/**
 * 定义 MockAgentRuntime 类，封装当前模块的状态和行为。
 */
export class MockAgentRuntime extends MockTurnRuntime {}

/**
 * 归一化 normalize input 相关数据。
 *
 * @param {unknown} input - input 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeInput(input) {
  return userInputToText(input);
}

export { defaultMockResponse };
