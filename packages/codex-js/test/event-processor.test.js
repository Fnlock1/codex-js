/**
 * 中文模块说明：test/event-processor.test.js
 *
 * Node 内置测试套件，覆盖 codex-js 的核心运行时和工具行为。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODEX_STATUS,
  HumanExecEventProcessor,
  JsonlExecEventProcessor,
  createErrorEvent,
  createAssistantMessageItem,
  createItemCompletedEvent,
  createTurnFailedEvent,
  processEventStream
} from "../src/index.js";

test("JsonlExecEventProcessor writes events to JSONL", async () => {
  const output = createWritableCapture();
  const processor = new JsonlExecEventProcessor(output);
  const item = createAssistantMessageItem("hello", {
    status: "completed"
  });

  const status = await processEventStream([
    createItemCompletedEvent(item)
  ], processor);

  assert.equal(status, CODEX_STATUS.RUNNING);
  assert.equal(JSON.parse(output.text).type, "item.completed");
  assert.equal(processor.finalMessage, "hello");
});

test("HumanExecEventProcessor renders assistant final message", async () => {
  const output = createWritableCapture();
  const processor = new HumanExecEventProcessor(output);
  const item = createAssistantMessageItem("hello", {
    status: "completed"
  });

  await processEventStream([
    createItemCompletedEvent(item)
  ], processor);

  assert.equal(output.text, "hello\n");
});

test("HumanExecEventProcessor renders failed turn events", async () => {
  const output = createWritableCapture();
  const processor = new HumanExecEventProcessor(output);
  const status = await processEventStream([
    createTurnFailedEvent(new Error("model unavailable")),
    createErrorEvent(new Error("model unavailable"))
  ], processor);

  assert.equal(status, CODEX_STATUS.INITIATE_SHUTDOWN);
  assert.match(output.text, /turn failed: model unavailable/);
  assert.match(output.text, /error: model unavailable/);
});

/**
 * 创建 create writable capture 相关数据。
 * @returns {unknown} 返回处理后的结果。
 */
function createWritableCapture() {
  return {
    text: "",
    /**
     * 写入 write 相关数据。
     *
     * @param {unknown} chunk - chunk 参数。
     * @returns {unknown} 返回处理后的结果。
     */
    write(chunk) {
      this.text += String(chunk);
      return true;
    }
  };
}
