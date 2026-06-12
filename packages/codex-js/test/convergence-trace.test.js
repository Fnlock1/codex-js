import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completeConvergenceTrace,
  convergenceTraceToJSON,
  createConvergenceTrace,
  recordConvergenceBudgetWarning,
  recordConvergenceRepeatedToolWarning,
  recordConvergenceToolCall
} from "../src/index.js";

test("convergence trace records compact tool-loop summary", () => {
  const trace = createConvergenceTrace({
    maxToolIterations: 5,
    doneCriteria: ["finish"]
  });

  recordConvergenceToolCall(trace, {
    iteration: 0,
    toolName: "read_file"
  });
  recordConvergenceToolCall(trace, {
    iteration: 1,
    toolName: "shell_command",
    failed: true,
    compressedOutput: true
  });
  recordConvergenceBudgetWarning(trace);
  recordConvergenceRepeatedToolWarning(trace, {
    toolName: "read_file",
    repeatedCount: 3,
    threshold: 3,
    signature: "read_file:{}"
  });
  completeConvergenceTrace(trace, {
    reason: "final_answer"
  });

  assert.deepEqual(convergenceTraceToJSON(trace), {
    status: "completed",
    maxToolIterations: 5,
    toolIterations: 2,
    toolCalls: 2,
    failedToolCalls: 1,
    uniqueTools: ["read_file", "shell_command"],
    compressedToolOutputs: 1,
    budgetWarningInjected: true,
    repeatedToolWarningInjected: true,
    repeatedToolCall: {
      toolName: "read_file",
      repeatedCount: 3,
      threshold: 3,
      signature: "read_file:{}"
    },
    doneCriteriaCount: 1,
    stopReason: "final_answer",
    errorCode: null
  });
});
