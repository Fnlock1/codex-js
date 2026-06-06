import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { test } from "node:test";
import {
  MockAgentRuntime,
  LoopingTurnRuntime,
  MockModelClient,
  MockTurnRuntime,
  NoopToolCallRuntime,
  SafeToolCallRuntime,
  TOOL_CALL_RESULT_STATUSES,
  TurnRuntime,
  createToolCallResult,
  createScriptedModelClient,
  createModelResponseItem,
  createTurnContext,
  isThreadId,
  normalizeInput
} from "../src/index.js";

test("createTurnContext normalizes input and serializes core fields", () => {
  const context = createTurnContext({
    input: "hello",
    workingDirectory: "/workspace",
    source: "test"
  });
  const json = context.toJSON();

  assert.equal(isThreadId(json.thread_id), true);
  assert.equal(context.inputText(), "hello");
  assert.equal(isAbsolute(json.working_directory), true);
  assert.match(json.working_directory.replace(/\\/g, "/"), /\/workspace$/);
  assert.equal(json.metadata.source, "test");
});

test("TurnRuntime base class requires implementation", async () => {
  const runtime = new TurnRuntime();

  await assert.rejects(
    async () => {
      for await (const _event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
        // unreachable
      }
    },
    /must be implemented/
  );
});

test("MockTurnRuntime emits a full mock turn lifecycle", async () => {
  const runtime = new MockTurnRuntime({
    mockResponse: "done"
  });
  const context = createTurnContext({
    input: "hello"
  });
  const events = [];

  for await (const event of runtime.runTurn(context)) {
    events.push(event);
  }

  assert.equal(events[0].type, "thread.started");
  assert.equal(events[1].type, "turn.started");
  assert.ok(events.some((event) => event.type === "item.updated"));
  assert.equal(events.at(-1).type, "turn.completed");
});

test("MockTurnRuntime can use an injected model client", async () => {
  const runtime = new MockTurnRuntime({
    modelClient: {
      createSession() {
        return {
          async *streamResponse() {
            yield createModelResponseItem({ text: "chunk one" });
            yield createModelResponseItem({ text: " chunk two" });
          }
        };
      }
    }
  });
  const events = [];

  for await (const event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
    events.push(event);
  }

  assert.equal(events.at(-2).item.content[0].text, "chunk one chunk two");
});

test("MockTurnRuntime accepts MockModelClient injection", async () => {
  const runtime = new MockTurnRuntime({
    modelClient: new MockModelClient({
      mockResponse: "from model"
    })
  });
  const events = [];

  for await (const event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
    events.push(event);
  }

  assert.equal(events.at(-2).item.content[0].text, "from model");
});

test("MockTurnRuntime emits reasoning items from model response items", async () => {
  const runtime = new MockTurnRuntime({
    modelClient: {
      createSession() {
        return {
          async *streamResponse() {
            yield createModelResponseItem({
              type: "reasoning",
              summaryText: "inspect files",
              rawContent: "private chain"
            });
            yield createModelResponseItem({
              text: "done"
            });
          }
        };
      }
    }
  });
  const events = [];

  for await (const event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
    events.push(event);
  }

  const reasoning = events.find((event) => (
    event.type === "item.completed" &&
    event.item?.type === "reasoning"
  ));

  assert.deepEqual(reasoning.item.summary_text, ["inspect files"]);
  assert.deepEqual(reasoning.item.raw_content, ["private chain"]);
  assert.equal(events.at(-2).item.content[0].text, "done");
});

test("MockTurnRuntime emits tool call item events without executing real tools", async () => {
  const runtime = new MockTurnRuntime({
    modelClient: {
      createSession() {
        return {
          async *streamResponse() {
            yield createModelResponseItem({
              type: "tool_call",
              callId: "call-1",
              name: "apply_patch",
              arguments: {
                patch: "noop"
              }
            });
            yield createModelResponseItem({
              text: "after tool"
            });
          }
        };
      }
    },
    toolRuntime: new NoopToolCallRuntime()
  });
  const events = [];

  for await (const event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
    events.push(event);
  }

  const started = events.find((event) => (
    event.type === "item.started" &&
    event.item?.type === "tool_call"
  ));
  const completed = events.find((event) => (
    event.type === "item.completed" &&
    event.item?.type === "tool_call"
  ));
  const result = events.find((event) => (
    event.type === "item.completed" &&
    event.item?.type === "tool_result"
  ));

  assert.equal(started.item.call_id, "call-1");
  assert.equal(started.item.name, "apply_patch");
  assert.equal(completed.item.status, "failed");
  assert.equal(completed.item.error, "not_implemented");
  assert.equal(result.item.status, "failed");
  assert.equal(result.item.error, "not_implemented");
  assert.equal(result.item.response_input_item.type, "function_call_output");
  assert.equal(result.item.response_input_item.call_id, "call-1");
  assert.equal(result.item.response_input_item.output.success, false);
  assert.equal(events.at(-2).item.content[0].text, "after tool");
});

test("MockTurnRuntime emits custom tool call output results", async () => {
  const runtime = new MockTurnRuntime({
    modelClient: {
      createSession() {
        return {
          async *streamResponse() {
            yield createModelResponseItem({
              type: "custom_tool_call",
              callId: "call-1",
              name: "apply_patch",
              input: "patch"
            });
          }
        };
      }
    },
    toolRuntime: {
      async run(toolCall) {
        return createToolCallResult({
          callId: toolCall.call_id,
          name: toolCall.name,
          status: TOOL_CALL_RESULT_STATUSES.COMPLETED,
          output: "patched"
        });
      }
    }
  });
  const events = [];

  for await (const event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
    events.push(event);
  }

  const result = events.find((event) => (
    event.type === "item.completed" &&
    event.item?.type === "tool_result"
  ));

  assert.equal(result.item.status, "completed");
  assert.equal(result.item.response_input_item.type, "custom_tool_call_output");
  assert.equal(result.item.response_input_item.call_id, "call-1");
  assert.equal(result.item.response_input_item.name, "apply_patch");
  assert.equal(result.item.response_input_item.output.success, true);
});

test("MockTurnRuntime can use an injected tool runtime", async () => {
  const runtime = new MockTurnRuntime({
    modelClient: {
      createSession() {
        return {
          async *streamResponse() {
            yield createModelResponseItem({
              type: "tool_call",
              callId: "call-1",
              name: "test_tool"
            });
          }
        };
      }
    },
    toolRuntime: {
      async run(toolCall) {
        return createToolCallResult({
          callId: toolCall.call_id,
          name: toolCall.name,
          status: TOOL_CALL_RESULT_STATUSES.COMPLETED,
          output: "ok"
        });
      }
    }
  });
  const events = [];

  for await (const event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
    events.push(event);
  }

  const completed = events.find((event) => (
    event.type === "item.completed" &&
    event.item?.type === "tool_call"
  ));
  const result = events.find((event) => (
    event.type === "item.completed" &&
    event.item?.type === "tool_result"
  ));

  assert.equal(completed.item.status, "completed");
  assert.equal(completed.item.output, "ok");
  assert.equal(result.item.status, "completed");
  assert.equal(result.item.output, "ok");
});

test("MockTurnRuntime converts model errors into failed turn events", async () => {
  const runtime = new MockTurnRuntime({
    modelClient: {
      createSession() {
        return {
          async *streamResponse() {
            throw new Error("model unavailable");
          }
        };
      }
    }
  });
  const events = [];

  for await (const event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
    events.push(event);
  }

  assert.equal(events.at(-2).type, "turn.failed");
  assert.equal(events.at(-2).error.message, "model unavailable");
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).message, "model unavailable");
  assert.equal(events.some((event) => (
    event.type === "item.completed" &&
    event.item?.role === "assistant" &&
    event.item.status === "failed"
  )), true);
});

test("MockTurnRuntime converts tool runtime errors into failed turn events", async () => {
  const runtime = new MockTurnRuntime({
    modelClient: {
      createSession() {
        return {
          async *streamResponse() {
            yield createModelResponseItem({
              type: "tool_call",
              callId: "call-1",
              name: "test_tool"
            });
          }
        };
      }
    },
    toolRuntime: {
      async run() {
        throw new Error("tool unavailable");
      }
    }
  });
  const events = [];

  for await (const event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
    events.push(event);
  }

  assert.equal(events.at(-2).type, "turn.failed");
  assert.equal(events.at(-2).error.message, "tool unavailable");
  assert.equal(events.at(-1).type, "error");
});

test("LoopingTurnRuntime feeds function call output back into the model", async () => {
  const modelClient = createScriptedModelClient([
    [
      {
        type: "function_call",
        callId: "call-1",
        name: "test_tool",
        arguments: {
          value: 1
        }
      }
    ],
    [
      {
        text: "final answer"
      }
    ]
  ]);
  const runtime = new LoopingTurnRuntime({
    modelClient,
    toolRuntime: {
      async run(toolCall) {
        return createToolCallResult({
          callId: toolCall.call_id,
          name: toolCall.name,
          status: TOOL_CALL_RESULT_STATUSES.COMPLETED,
          output: "ok"
        });
      }
    }
  });
  const events = [];

  for await (const event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
    events.push(event);
  }

  const toolResult = events.find((event) => (
    event.type === "item.completed" &&
    event.item?.type === "tool_result"
  ));

  assert.equal(events.at(-2).item.content[0].text, "final answer");
  assert.equal(events.at(-1).type, "turn.completed");
  assert.equal(toolResult.item.response_input_item.type, "function_call_output");
  assert.equal(modelClient.lastSession.prompts.length, 2);
  assert.equal(
    modelClient.lastSession.prompts[1].responseInputItems[0].type,
    "function_call_output"
  );
});

test("LoopingTurnRuntime can use SafeToolCallRuntime for dry-run shell tools", async () => {
  const modelClient = createScriptedModelClient([
    [
      {
        type: "function_call",
        callId: "call-1",
        name: "shell_command",
        arguments: {
          command: "npm test"
        }
      }
    ],
    [
      {
        text: "checked"
      }
    ]
  ]);
  const runtime = new LoopingTurnRuntime({
    modelClient,
    toolRuntime: new SafeToolCallRuntime({
      workingDirectory: "/workspace"
    })
  });
  const events = [];

  for await (const event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
    events.push(event);
  }

  const toolResult = events.find((event) => (
    event.type === "item.completed" &&
    event.item?.type === "tool_result"
  ));

  assert.equal(toolResult.item.status, "completed");
  assert.equal(toolResult.item.output, "dry-run: npm test");
  assert.equal(
    modelClient.lastSession.prompts[1].responseInputItems[0].output.body,
    "dry-run: npm test"
  );
  assert.equal(events.at(-2).item.content[0].text, "checked");
});

test("LoopingTurnRuntime can use SafeToolCallRuntime for apply_patch dry-runs", async () => {
  const modelClient = createScriptedModelClient([
    [
      {
        type: "function_call",
        callId: "call-1",
        name: "apply_patch",
        arguments: {
          patch: `*** Begin Patch
*** Add File: README.md
+hello
*** End Patch`
        }
      }
    ],
    [
      {
        text: "patch previewed"
      }
    ]
  ]);
  const runtime = new LoopingTurnRuntime({
    modelClient,
    toolRuntime: new SafeToolCallRuntime()
  });
  const events = [];

  for await (const event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
    events.push(event);
  }

  const toolResult = events.find((event) => (
    event.type === "item.completed" &&
    event.item?.type === "tool_result"
  ));

  assert.equal(toolResult.item.status, "completed");
  assert.match(toolResult.item.output, /patch was not applied/);
  assert.equal(toolResult.item.response_input_item.type, "function_call_output");
  assert.match(
    modelClient.lastSession.prompts[1].responseInputItems[0].output.body,
    /patch was not applied/
  );
  assert.equal(events.at(-2).item.content[0].text, "patch previewed");
});

test("LoopingTurnRuntime feeds apply_patch plan output back into the model", async () => {
  const modelClient = createScriptedModelClient([
    [
      {
        type: "function_call",
        callId: "call-1",
        name: "apply_patch",
        arguments: {
          patch: `*** Begin Patch
*** Update File: README.md
@@
-old
+new
*** End Patch`
        }
      }
    ],
    [
      {
        text: "patch planned"
      }
    ]
  ]);
  const runtime = new LoopingTurnRuntime({
    modelClient,
    toolRuntime: new SafeToolCallRuntime({
      allowApplyPatch: true,
      workingDirectory: "/workspace",
      applyPatchFileProvider: {
        "README.md": "old\n"
      }
    })
  });
  const events = [];

  for await (const event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
    events.push(event);
  }

  const toolResult = events.find((event) => (
    event.type === "item.completed" &&
    event.item?.type === "tool_result"
  ));

  assert.equal(toolResult.item.status, "completed");
  assert.match(toolResult.item.output, /plan computed successfully/);
  assert.equal(toolResult.item.response_input_item.type, "function_call_output");
  assert.match(
    modelClient.lastSession.prompts[1].responseInputItems[0].output.body,
    /patch was not applied/
  );
  assert.equal(events.at(-2).item.content[0].text, "patch planned");
});

test("LoopingTurnRuntime feeds custom tool output back into the model", async () => {
  const modelClient = createScriptedModelClient([
    [
      {
        type: "custom_tool_call",
        callId: "call-1",
        name: "apply_patch",
        input: "patch"
      }
    ],
    [
      {
        text: "patched"
      }
    ]
  ]);
  const runtime = new LoopingTurnRuntime({
    modelClient,
    toolRuntime: {
      async run(toolCall) {
        return createToolCallResult({
          callId: toolCall.call_id,
          name: toolCall.name,
          status: TOOL_CALL_RESULT_STATUSES.COMPLETED,
          output: "ok"
        });
      }
    }
  });
  const events = [];

  for await (const event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
    events.push(event);
  }

  const toolResult = events.find((event) => (
    event.type === "item.completed" &&
    event.item?.type === "tool_result"
  ));

  assert.equal(toolResult.item.response_input_item.type, "custom_tool_call_output");
  assert.equal(
    modelClient.lastSession.prompts[1].responseInputItems[0].type,
    "custom_tool_call_output"
  );
  assert.equal(events.at(-2).item.content[0].text, "patched");
});

test("LoopingTurnRuntime fails when max tool iterations are exceeded", async () => {
  const runtime = new LoopingTurnRuntime({
    maxToolIterations: 1,
    modelClient: createScriptedModelClient([
      [
        {
          type: "function_call",
          callId: "call-1",
          name: "test_tool"
        }
      ],
      [
        {
          type: "function_call",
          callId: "call-2",
          name: "test_tool"
        }
      ]
    ]),
    toolRuntime: {
      async run(toolCall) {
        return createToolCallResult({
          callId: toolCall.call_id,
          name: toolCall.name,
          status: TOOL_CALL_RESULT_STATUSES.COMPLETED,
          output: "ok"
        });
      }
    }
  });
  const events = [];

  for await (const event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
    events.push(event);
  }

  assert.equal(events.at(-2).type, "turn.failed");
  assert.match(events.at(-2).error.message, /max tool iterations exceeded/);
  assert.equal(events.at(-1).type, "error");
});

test("MockAgentRuntime remains a compatibility alias", async () => {
  const runtime = new MockAgentRuntime({
    mockResponse: "done"
  });
  const events = [];

  for await (const event of runtime.runTurn(createTurnContext({ input: "hello" }))) {
    events.push(event);
  }

  assert.equal(events.at(-2).item.content[0].text, "done");
  assert.equal(normalizeInput("hello"), "hello");
});
