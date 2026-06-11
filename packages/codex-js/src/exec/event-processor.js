/**
 * 中文模块说明：src/exec/event-processor.js
 *
 * 命令执行、PTY 会话、输出事件和执行权限策略。
 */
import { EVENT_TYPES, getItemText } from "../protocol/index.js";

export const CODEX_STATUS = Object.freeze({
  RUNNING: "running",
  INITIATE_SHUTDOWN: "initiate_shutdown"
});

/**
 * 定义 JsonlExecEventProcessor 类，封装当前模块的状态和行为。
 */
export class JsonlExecEventProcessor {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} output - output 参数。
   */
  constructor(output) {
    this.output = output;
    this.finalMessage = null;
  }

  /**
   * 处理 process event 相关逻辑。
   *
   * @param {unknown} event - event 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  processEvent(event) {
    this.captureFinalMessage(event);
    this.output.write(`${JSON.stringify(event)}\n`);
    return statusForEvent(event);
  }

  /**
   * 处理 process warning 相关逻辑。
   *
   * @param {unknown} message - message 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  processWarning(message) {
    this.output.write(`${JSON.stringify({
      type: EVENT_TYPES.ERROR,
      message: String(message)
    })}\n`);
    return CODEX_STATUS.RUNNING;
  }

  /**
   * 处理 print final output 相关逻辑。
   * @returns {unknown} 返回处理后的结果。
   */
  printFinalOutput() {}

  /**
   * 处理 capture final message 相关逻辑。
   *
   * @param {unknown} event - event 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  captureFinalMessage(event) {
    if (
      event.type === EVENT_TYPES.ITEM_COMPLETED &&
      event.item?.role === "assistant"
    ) {
      this.finalMessage = getItemText(event.item);
    }
  }
}

/**
 * 定义 HumanExecEventProcessor 类，封装当前模块的状态和行为。
 */
export class HumanExecEventProcessor {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} output - output 参数。
   */
  constructor(output) {
    this.output = output;
    this.finalMessage = null;
    this.finalMessageRendered = false;
  }

  /**
   * 处理 process event 相关逻辑。
   *
   * @param {unknown} event - event 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  processEvent(event) {
    if (event.type === EVENT_TYPES.TURN_FAILED) {
      this.renderTurnFailed(event.error);
    }

    if (event.type === EVENT_TYPES.ERROR) {
      this.renderError(event);
    }

    if (event.type === EVENT_TYPES.ITEM_STARTED) {
      this.renderItemStarted(event.item);
    }

    if (event.type === EVENT_TYPES.ITEM_COMPLETED) {
      this.renderItemCompleted(event.item);
    }

    return statusForEvent(event);
  }

  /**
   * 处理 process warning 相关逻辑。
   *
   * @param {unknown} message - message 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  processWarning(message) {
    this.output.write(`warning: ${String(message)}\n`);
    return CODEX_STATUS.RUNNING;
  }

  /**
   * 处理 print final output 相关逻辑。
   * @returns {unknown} 返回处理后的结果。
   */
  printFinalOutput() {
    if (this.finalMessage && !this.finalMessageRendered) {
      this.output.write(`${this.finalMessage}\n`);
      this.finalMessageRendered = true;
    }
  }

  /**
   * 处理 render item started 相关逻辑。
   *
   * @param {unknown} item - item 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  renderItemStarted(item) {
    if (item?.type === "command_execution") {
      const cwd = item.cwd ? ` in ${item.cwd}` : "";
      this.output.write(`exec\n${item.command}${cwd}\n`);
    }
  }

  /**
   * 处理 render turn failed 相关逻辑。
   *
   * @param {unknown} error - error 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  renderTurnFailed(error) {
    this.output.write(`turn failed: ${error?.message ?? "unknown error"}\n`);
  }

  /**
   * 处理 render error 相关逻辑。
   *
   * @param {unknown} event - event 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  renderError(event) {
    this.output.write(`error: ${event.message ?? "unknown error"}\n`);
  }

  /**
   * 处理 render item completed 相关逻辑。
   *
   * @param {unknown} item - item 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  renderItemCompleted(item) {
    if (item?.role === "assistant") {
      this.finalMessage = getItemText(item);
      this.output.write(`${this.finalMessage}\n`);
      this.finalMessageRendered = true;
      return;
    }

    if (item?.type === "command_execution") {
      const status = item.status === "completed" ? "succeeded" : item.status;
      this.output.write(`${status}:\n`);

      if (item.aggregated_output) {
        this.output.write(`${item.aggregated_output}\n`);
      }
    }
  }
}

/**
 * 处理 process event stream 相关逻辑。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} events - events 参数。
 * @param {unknown} processor - processor 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function processEventStream(events, processor) {
  let status = CODEX_STATUS.RUNNING;

  for await (const event of events) {
    status = processor.processEvent(event);
  }

  processor.printFinalOutput();
  return status;
}

/**
 * 创建 create exec event processor 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createExecEventProcessor({ json, stdout, stderr }) {
  return json
    ? new JsonlExecEventProcessor(stdout)
    : new HumanExecEventProcessor(stderr ?? stdout);
}

/**
 * 处理 status for event 相关逻辑。
 *
 * @param {unknown} event - event 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function statusForEvent(event) {
  if (
    event.type === EVENT_TYPES.TURN_COMPLETED ||
    event.type === EVENT_TYPES.TURN_FAILED ||
    event.type === EVENT_TYPES.ERROR
  ) {
    return CODEX_STATUS.INITIATE_SHUTDOWN;
  }

  return CODEX_STATUS.RUNNING;
}
