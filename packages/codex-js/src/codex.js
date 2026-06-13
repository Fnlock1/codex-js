/**
 * 中文模块说明：src/codex.js
 *
 * Codex 门面对象，负责创建或恢复 Thread。
 */
import { Thread } from "./thread.js";

/**
 * codex-js 的公共门面。
 *
 * 这个类不直接执行模型或工具，只负责保存全局选项，并创建/恢复 Thread。
 * 真正的一轮 agent 执行会从 Thread.run 或 Thread.runStreamed 开始。
 */
export class Codex {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.options = { ...options };
  }

  /**
   * 启动 start thread 相关数据。
   *
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  startThread(options = {}) {
    return new Thread(this.options, options);
  }

  /**
   * 恢复 resume thread 相关数据。
   *
   * @param {unknown} id - id 参数。
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  resumeThread(id, options = {}) {
    return new Thread(this.options, options, id);
  }
}
