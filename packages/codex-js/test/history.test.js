import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HISTORY_ENTRY_TYPES,
  SESSION_SCHEMA_VERSION,
  appendTurnToSession,
  compactHistoryIfNeeded,
  createAssistantMessageItem,
  createItemCompletedEvent,
  createSessionRecord,
  createToolResultItem,
  createTurnRecord,
  historyEntriesFromTurn,
  normalizeSessionRecord,
  rollbackSessionTurns,
  responseInputItemsFromHistory
} from "../src/index.js";

test("createTurnRecord extracts history, response input items, and rollout entries", () => {
  const assistant = createAssistantMessageItem("done", {
    status: "completed"
  });
  const toolResult = createToolResultItem({
    callId: "call-1",
    name: "shell_command",
    output: "ok",
    responseInputItem: {
      type: "function_call_output",
      call_id: "call-1",
      output: {
        body: "ok",
        success: true
      }
    }
  });
  const turn = createTurnRecord({
    input: "hello",
    events: [
      createItemCompletedEvent(assistant),
      createItemCompletedEvent(toolResult),
      {
        type: "turn.completed"
      }
    ],
    turnIndex: 0
  });

  assert.equal(turn.history[0].type, HISTORY_ENTRY_TYPES.USER_INPUT);
  assert.equal(turn.history[1].type, HISTORY_ENTRY_TYPES.ASSISTANT_MESSAGE);
  assert.equal(turn.history[2].type, HISTORY_ENTRY_TYPES.TOOL_RESULT);
  assert.equal(turn.responseInputItems[0].role, "user");
  assert.equal(turn.responseInputItems[1].role, "assistant");
  assert.equal(turn.responseInputItems[2].type, "function_call_output");
  assert.equal(turn.rollout.length, 3);
});

test("appendTurnToSession upgrades session records and appends history", () => {
  const session = createSessionRecord({
    threadId: "thread-1",
    workingDirectory: "/workspace"
  });
  const next = appendTurnToSession(session, {
    input: "hello",
    events: [
      createItemCompletedEvent(createAssistantMessageItem("done", {
        status: "completed"
      }))
    ]
  });

  assert.equal(next.schemaVersion, SESSION_SCHEMA_VERSION);
  assert.equal(next.turns.length, 1);
  assert.equal(next.history.length, 2);
  assert.equal(next.responseInputItems.length, 2);
});

test("normalizeSessionRecord derives history from legacy turns", () => {
  const legacy = {
    threadId: "thread-1",
    workingDirectory: "/workspace",
    turns: [
      {
        input: "legacy",
        events: [
          createItemCompletedEvent(createAssistantMessageItem("done", {
            status: "completed"
          }))
        ]
      }
    ]
  };
  const normalized = normalizeSessionRecord(legacy);

  assert.equal(normalized.schemaVersion, SESSION_SCHEMA_VERSION);
  assert.equal(normalized.history[0].text, "legacy");
  assert.equal(normalized.history[1].text, "done");
  assert.equal(normalized.responseInputItems.length, 2);
});

test("responseInputItemsFromHistory maps compact summaries and tool outputs", () => {
  const items = responseInputItemsFromHistory([
    {
      type: HISTORY_ENTRY_TYPES.COMPACT_SUMMARY,
      text: "summary"
    },
    {
      type: HISTORY_ENTRY_TYPES.TOOL_RESULT,
      responseInputItem: {
        type: "function_call_output",
        call_id: "call-1",
        output: {
          body: "ok",
          success: true
        }
      }
    }
  ]);

  assert.equal(items[0].role, "system");
  assert.equal(items[1].type, "function_call_output");
});

test("compactHistoryIfNeeded keeps recent entries and creates summary", () => {
  const history = historyEntriesFromTurn({
    input: "first",
    events: [
      createItemCompletedEvent(createAssistantMessageItem("answer", {
        status: "completed"
      }))
    ],
    turnIndex: 0
  }).concat(historyEntriesFromTurn({
    input: "second",
    events: [
      createItemCompletedEvent(createAssistantMessageItem("answer 2", {
        status: "completed"
      }))
    ],
    turnIndex: 1
  }));
  const compacted = compactHistoryIfNeeded(history, {
    maxEntries: 2,
    keepEntries: 2
  });

  assert.equal(compacted.compacted, true);
  assert.equal(compacted.hiddenCount, 2);
  assert.equal(compacted.visibleHistory.length, 2);
  assert.match(compacted.summaryEntry.text, /Previous conversation compacted/);
});

test("rollbackSessionTurns removes recent turns and rebuilds model input history", () => {
  const session = appendTurnToSession(appendTurnToSession(createSessionRecord({
    threadId: "thread-1",
    workingDirectory: "/workspace"
  }), {
    input: "first",
    events: [
      createItemCompletedEvent(createAssistantMessageItem("one", {
        status: "completed"
      }))
    ]
  }), {
    input: "second",
    events: [
      createItemCompletedEvent(createAssistantMessageItem("two", {
        status: "completed"
      }))
    ]
  });
  const rolledBack = rollbackSessionTurns(session, {
    dropLastTurns: 1
  });

  assert.equal(rolledBack.turns.length, 1);
  assert.equal(rolledBack.history.some((entry) => entry.text === "second"), false);
  assert.equal(rolledBack.responseInputItems.some((item) => JSON.stringify(item).includes("two")), false);
  assert.equal(rolledBack.metadata.rollback.droppedTurns, 1);
});
