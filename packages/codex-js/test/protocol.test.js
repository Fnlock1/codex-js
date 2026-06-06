import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVAL_POLICIES,
  EVENT_TYPES,
  PERMISSION_PROFILES,
  SANDBOX_MODES,
  USER_INPUT_TYPES,
  createFunctionCallOutputPayload,
  createExecToolCallOutput,
  createAssistantMessageItem,
  createCommandExecutionItem,
  createReasoningItem,
  createResponseCustomToolCallItem,
  createResponseFunctionCallItem,
  createResponseFunctionCallOutputItem,
  createResponseInputMessageItem,
  createResponseMessageItem,
  createResponseReasoningItem,
  createResponseToolCallOutputItem,
  createToolCallItem,
  createToolResultItem,
  createLocalImageInput,
  createSessionId,
  createTextInput,
  createThreadId,
  createThreadStartedEvent,
  functionCallOutputPayloadToText,
  functionCallOutputPayloadToWireValue,
  getItemText,
  isSessionId,
  isThreadEvent,
  isThreadId,
  isThreadItem,
  normalizeUserInput,
  normalizeResponseItems,
  responseItemToText,
  sessionIdFromThreadId,
  threadIdFromSessionId,
  userInputToText
} from "../src/index.js";

test("protocol exports Codex-compatible event helpers", () => {
  const event = createThreadStartedEvent("thread_123");

  assert.equal(event.type, EVENT_TYPES.THREAD_STARTED);
  assert.equal(event.thread_id, "thread_123");
  assert.equal(isThreadEvent(event), true);
  assert.equal(isThreadEvent({ type: "unknown" }), false);
});

test("protocol exports item helpers", () => {
  const item = createAssistantMessageItem("hello");

  assert.equal(isThreadItem(item), true);
  assert.equal(getItemText(item), "hello");
});

test("protocol exports command execution items", () => {
  const item = createCommandExecutionItem({
    command: "npm test",
    output: createExecToolCallOutput({
      stdout: "ok",
      exitCode: 0
    }),
    approvalRequest: {
      type: "exec_approval_request"
    }
  });

  assert.equal(item.type, "command_execution");
  assert.equal(item.command, "npm test");
  assert.equal(item.aggregated_output, "ok");
  assert.equal(item.exit_code, 0);
  assert.equal(item.approval_request.type, "exec_approval_request");
});

test("protocol exports reasoning items", () => {
  const item = createReasoningItem({
    summaryText: ["thinking"],
    rawContent: ["raw"]
  });

  assert.equal(item.type, "reasoning");
  assert.deepEqual(item.summary_text, ["thinking"]);
  assert.deepEqual(item.raw_content, ["raw"]);
  assert.equal(getItemText(item), "thinking");
  assert.equal(isThreadItem(item), true);
});

test("protocol exports tool call items", () => {
  const item = createToolCallItem({
    callId: "call-1",
    name: "apply_patch",
    arguments: {
      patch: "noop"
    },
    output: "not implemented",
    status: "failed"
  });

  assert.equal(item.type, "tool_call");
  assert.equal(item.call_id, "call-1");
  assert.equal(item.name, "apply_patch");
  assert.equal(item.output, "not implemented");
  assert.equal(getItemText(item), "not implemented");
  assert.equal(isThreadItem(item), true);
});

test("protocol exports tool result items", () => {
  const item = createToolResultItem({
    callId: "call-1",
    name: "apply_patch",
    output: "patched",
    status: "completed"
  });

  assert.equal(item.type, "tool_result");
  assert.equal(item.call_id, "call-1");
  assert.equal(item.name, "apply_patch");
  assert.equal(getItemText(item), "patched");
  assert.equal(isThreadItem(item), true);
});

test("protocol exports Responses API style model item helpers", () => {
  const message = createResponseMessageItem({
    role: "assistant",
    text: "hello",
    phase: "final_answer"
  });
  const reasoning = createResponseReasoningItem({
    summaryText: "plan",
    rawContent: "private"
  });
  const call = createResponseFunctionCallItem({
    callId: "call-1",
    name: "shell_command",
    arguments: {
      command: "npm test"
    }
  });
  const custom = createResponseCustomToolCallItem({
    callId: "custom-1",
    name: "apply_patch",
    input: "patch"
  });

  assert.equal(message.type, "message");
  assert.equal(message.content[0].type, "output_text");
  assert.equal(message.phase, "final_answer");
  assert.equal(reasoning.type, "reasoning");
  assert.equal(reasoning.summary[0].type, "summary_text");
  assert.equal(call.type, "function_call");
  assert.equal(call.arguments, "{\"command\":\"npm test\"}");
  assert.equal(custom.type, "custom_tool_call");
  assert.equal(custom.input, "patch");
});

test("protocol creates Responses input message items", () => {
  const item = createResponseInputMessageItem({
    text: "hello"
  });

  assert.equal(item.type, "message");
  assert.equal(item.role, "user");
  assert.equal(item.content[0].type, "input_text");
  assert.equal(item.content[0].text, "hello");
});

test("protocol exports function call output payload helpers", () => {
  const textPayload = createFunctionCallOutputPayload("ok", {
    success: true
  });
  const structured = createResponseFunctionCallOutputItem({
    callId: "call-1",
    output: [
      {
        type: "input_text",
        text: "first"
      },
      {
        type: "input_image",
        image_url: "data:image/png;base64,AAA"
      },
      {
        type: "input_text",
        text: "second"
      }
    ]
  });

  assert.equal(functionCallOutputPayloadToWireValue(textPayload), "ok");
  assert.equal(textPayload.success, true);
  assert.equal(structured.type, "function_call_output");
  assert.equal(functionCallOutputPayloadToText(structured.output), "first\nsecond");
});

test("protocol creates tool call output items for normal and custom calls", () => {
  const normal = createResponseToolCallOutputItem({
    type: "tool_call",
    call_id: "call-1",
    name: "shell_command"
  }, {
    status: "completed",
    output: "ok"
  });
  const custom = createResponseToolCallOutputItem({
    type: "tool_call",
    call_id: "custom-1",
    name: "apply_patch",
    custom: true
  }, {
    status: "failed",
    output: "not implemented"
  });

  assert.equal(normal.type, "function_call_output");
  assert.equal(normal.call_id, "call-1");
  assert.equal(normal.output.success, true);
  assert.equal(functionCallOutputPayloadToText(normal.output), "ok");
  assert.equal(custom.type, "custom_tool_call_output");
  assert.equal(custom.call_id, "custom-1");
  assert.equal(custom.name, "apply_patch");
  assert.equal(custom.output.success, false);
});

test("protocol normalizes response item batches", () => {
  const items = normalizeResponseItems([
    {
      type: "message",
      role: "assistant",
      text: "hello"
    },
    {
      type: "reasoning",
      summaryText: "plan"
    },
    {
      type: "function_call",
      callId: "call-1",
      name: "shell_command",
      arguments: {
        command: "npm test"
      }
    },
    {
      type: "custom_tool_call",
      callId: "custom-1",
      name: "apply_patch",
      input: "patch"
    },
    {
      type: "function_call_output",
      callId: "call-1",
      output: "ok"
    }
  ]);

  assert.equal(items.length, 5);
  assert.equal(items[0].content[0].type, "output_text");
  assert.equal(items[1].summary[0].text, "plan");
  assert.equal(items[2].arguments, "{\"command\":\"npm test\"}");
  assert.equal(items[3].input, "patch");
  assert.equal(functionCallOutputPayloadToText(items[4].output), "ok");
});

test("protocol extracts text from response items", () => {
  assert.equal(responseItemToText(createResponseMessageItem({
    text: "hello"
  })), "hello");
  assert.equal(responseItemToText(createResponseReasoningItem({
    summaryText: "plan",
    rawContent: "details"
  })), "plan\ndetails");
  assert.equal(responseItemToText(createResponseFunctionCallOutputItem({
    callId: "call-1",
    output: "ok"
  })), "ok");
});

test("protocol includes first-stage permission constants", () => {
  assert.equal(APPROVAL_POLICIES.ON_REQUEST, "on-request");
  assert.equal(SANDBOX_MODES.READ_ONLY, "read-only");
  assert.deepEqual(PERMISSION_PROFILES.READ_ONLY, {
    approvalPolicy: "on-request",
    sandboxMode: "read-only"
  });
});

test("protocol creates UUID string thread and session identifiers", () => {
  const threadId = createThreadId();
  const sessionId = createSessionId();

  assert.equal(isThreadId(threadId), true);
  assert.equal(isSessionId(sessionId), true);
  assert.equal(sessionIdFromThreadId(threadId), threadId);
  assert.equal(threadIdFromSessionId(sessionId), sessionId);
  assert.equal(isThreadId(`thread_${threadId}`), false);
});

test("protocol normalizes user input entries", () => {
  const inputs = normalizeUserInput([
    "hello",
    createLocalImageInput("./screen.png")
  ]);

  assert.equal(inputs[0].type, USER_INPUT_TYPES.TEXT);
  assert.equal(inputs[0].text, "hello");
  assert.equal(inputs[1].type, USER_INPUT_TYPES.LOCAL_IMAGE);
  assert.equal(userInputToText(inputs), "hello\n[image: ./screen.png]");
});

test("protocol enforces text input size cap", () => {
  assert.throws(
    () => createTextInput("x".repeat((1 << 20) + 1)),
    /exceeds/
  );
});

test("protocol creates exec tool call output", () => {
  const output = createExecToolCallOutput({
    exitCode: 2,
    stdout: "out",
    stderr: "err",
    durationMs: 12,
    timedOut: true
  });

  assert.equal(output.exit_code, 2);
  assert.equal(output.stdout.text, "out");
  assert.equal(output.stderr.text, "err");
  assert.equal(output.aggregated_output.text, "outerr");
  assert.equal(output.duration_ms, 12);
  assert.equal(output.timed_out, true);
});
