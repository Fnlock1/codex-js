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

function createWritableCapture() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    }
  };
}
