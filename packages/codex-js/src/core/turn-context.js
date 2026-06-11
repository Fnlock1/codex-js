/**
 * 中文模块说明：src/core/turn-context.js
 *
 * agent turn 上下文、模型调用抽象、工具循环和 ReAct trace。
 */
import { resolve } from "node:path";
import { createThreadId, normalizeUserInput, userInputToText } from "../protocol/index.js";

/**
 * 定义 TurnContext 类，封装当前模块的状态和行为。
 */
export class TurnContext {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.threadId = options.threadId ?? createThreadId();
    this.input = normalizeUserInput(options.input ?? "");
    this.workingDirectory = resolve(options.workingDirectory ?? process.cwd());
    this.tools = Array.isArray(options.tools) ? options.tools : [];
    this.responseInputItems = Array.isArray(options.responseInputItems)
      ? options.responseInputItems
      : [];
    this.memories = Array.isArray(options.memories) ? options.memories : [];
    this.memoryContextText = String(options.memoryContextText ?? "");
    this.history = Array.isArray(options.history) ? options.history : [];
    this.metadata = {
      startedAt: options.startedAt ?? new Date().toISOString(),
      source: options.source ?? "codex-js",
      ...(options.metadata ?? {})
    };
  }

  /**
   * 提取当前 turn 的纯文本输入。
   * @returns {unknown} 返回处理后的结果。
   */
  inputText() {
    return userInputToText(this.input);
  }

  /**
   * 转换为可序列化 JSON 对象。
   * @returns {unknown} 返回处理后的结果。
   */
  toJSON() {
    return {
      thread_id: this.threadId,
      input: this.input,
      working_directory: this.workingDirectory,
      tools: this.tools,
      response_input_items: this.responseInputItems,
      memories: this.memories,
      memory_context_text: this.memoryContextText,
      history: this.history,
      metadata: this.metadata
    };
  }
}

/**
 * 创建 create turn context 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createTurnContext(options = {}) {
  return new TurnContext(options);
}
