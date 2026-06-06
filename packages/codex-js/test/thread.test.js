import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Codex,
  MockTurnRuntime,
  createAssistantMessageItem,
  createItemCompletedEvent,
  createTurnCompletedEvent,
  isThreadId
} from "../src/index.js";

test("thread.run returns a final response and stable thread id", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-thread-"));

  try {
    const codex = new Codex({
      sessionStoreDirectory,
      mockResponse: "done"
    });
    const thread = codex.startThread();
    const result = await thread.run("diagnose");

    assert.equal(result.finalResponse, "done");
    assert.equal(result.threadId, thread.id);
    assert.equal(isThreadId(result.threadId), true);
    assert.ok(result.items.some((item) => item.role === "assistant"));
    assert.ok(result.events.some((event) => event.type === "turn.completed"));
  } finally {
    await rm(sessionStoreDirectory, { recursive: true, force: true });
  }
});

test("resumeThread can load a previously created mock session", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-resume-"));

  try {
    const codex = new Codex({
      sessionStoreDirectory
    });
    const firstThread = codex.startThread();
    await firstThread.run("first");

    const resumedThread = codex.resumeThread(firstThread.id);
    const loaded = await resumedThread.load();

    assert.equal(loaded.threadId, firstThread.id);
    assert.equal(loaded.turns.length, 1);
    assert.equal(loaded.turns[0].input, "first");
    assert.equal(loaded.history[0].text, "first");
    assert.equal(loaded.responseInputItems.length, 2);
  } finally {
    await rm(sessionStoreDirectory, { recursive: true, force: true });
  }
});

test("thread passes persisted response input items into the next turn", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-history-"));
  const contexts = [];

  try {
    const codex = new Codex({
      sessionStoreDirectory,
      runtime: {
        async *runTurn(context) {
          contexts.push(context.toJSON());
          yield createItemCompletedEvent(createAssistantMessageItem(`turn ${contexts.length}`, {
            status: "completed"
          }));
          yield createTurnCompletedEvent();
        }
      }
    });
    const thread = codex.startThread();

    await thread.run("first");
    await thread.run("second");

    assert.equal(contexts[0].response_input_items.length, 0);
    assert.equal(contexts[1].response_input_items.length, 2);
    assert.equal(contexts[1].response_input_items[0].role, "user");
    assert.equal(contexts[1].response_input_items[1].role, "assistant");
  } finally {
    await rm(sessionStoreDirectory, { recursive: true, force: true });
  }
});

test("thread.injectResponseItems appends raw model-visible history", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-inject-"));
  const contexts = [];

  try {
    const codex = new Codex({
      sessionStoreDirectory,
      runtime: {
        async *runTurn(context) {
          contexts.push(context.toJSON());
          yield createItemCompletedEvent(createAssistantMessageItem("done", {
            status: "completed"
          }));
          yield createTurnCompletedEvent();
        }
      }
    });
    const thread = codex.startThread();

    await thread.injectResponseItems([
      {
        id: "injected-1",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "Injected context"
          }
        ]
      }
    ]);
    await thread.run("continue");

    const loaded = await thread.load();

    assert.equal(loaded.turns.length, 1);
    assert.equal(loaded.history[0].type, "injected_response_item");
    assert.equal(contexts[0].response_input_items[0].id, "injected-1");
    assert.equal(contexts[0].response_input_items[0].content[0].text, "Injected context");
  } finally {
    await rm(sessionStoreDirectory, { recursive: true, force: true });
  }
});

test("thread session compaction creates a summary for long histories", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-compact-"));

  try {
    const codex = new Codex({
      sessionStoreDirectory,
      mockResponse: "done",
      compaction: {
        maxEntries: 2,
        keepEntries: 2
      }
    });
    const thread = codex.startThread();

    await thread.run("first");
    await thread.run("second");

    const loaded = await thread.load();

    assert.equal(loaded.compact.compacted, true);
    assert.equal(loaded.responseInputItems[0].role, "system");
    assert.match(loaded.responseInputItems[0].content[0].text, /Previous conversation compacted/);
  } finally {
    await rm(sessionStoreDirectory, { recursive: true, force: true });
  }
});

test("thread can use an injected turn runtime", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-runtime-"));

  try {
    const codex = new Codex({
      sessionStoreDirectory,
      runtime: new MockTurnRuntime({
        mockResponse: "custom"
      })
    });
    const result = await codex.startThread().run("hello");

    assert.equal(result.finalResponse, "custom");
  } finally {
    await rm(sessionStoreDirectory, { recursive: true, force: true });
  }
});

test("thread.run returns failed result metadata when a turn fails", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-failed-"));

  try {
    const codex = new Codex({
      sessionStoreDirectory,
      runtime: {
        async *runTurn() {
          yield {
            type: "thread.started",
            thread_id: "thread-ignored"
          };
          yield {
            type: "turn.failed",
            error: {
              message: "boom"
            }
          };
        }
      }
    });
    const result = await codex.startThread().run("hello");

    assert.equal(result.failed, true);
    assert.equal(result.error.message, "boom");
    assert.equal(result.events.at(-1).type, "turn.failed");
  } finally {
    await rm(sessionStoreDirectory, { recursive: true, force: true });
  }
});
