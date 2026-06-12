export function createConvergenceTrace(options = {}) {
  return {
    status: "running",
    maxToolIterations: options.maxToolIterations ?? null,
    toolIterations: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    uniqueTools: [],
    compressedToolOutputs: 0,
    budgetWarningInjected: false,
    repeatedToolWarningInjected: false,
    repeatedToolCall: null,
    doneCriteriaCount: Array.isArray(options.doneCriteria) ? options.doneCriteria.length : 0,
    stopReason: null,
    errorCode: null
  };
}

export function recordConvergenceToolCall(trace, options = {}) {
  trace.toolCalls += 1;
  trace.toolIterations = Math.max(trace.toolIterations, Number(options.iteration ?? 0) + 1);

  const toolName = String(options.toolName ?? "");

  if (toolName && !trace.uniqueTools.includes(toolName)) {
    trace.uniqueTools.push(toolName);
  }

  if (options.failed) {
    trace.failedToolCalls += 1;
  }

  if (options.compressedOutput) {
    trace.compressedToolOutputs += 1;
  }

  return trace;
}

export function recordConvergenceBudgetWarning(trace) {
  trace.budgetWarningInjected = true;
  return trace;
}

export function recordConvergenceRepeatedToolWarning(trace, loopState = {}) {
  trace.repeatedToolWarningInjected = true;
  trace.repeatedToolCall = {
    toolName: loopState.toolName ?? null,
    repeatedCount: loopState.repeatedCount ?? null,
    threshold: loopState.threshold ?? null,
    signature: loopState.signature ?? null
  };
  return trace;
}

export function completeConvergenceTrace(trace, options = {}) {
  trace.status = options.failed ? "failed" : "completed";
  trace.stopReason = options.reason ?? (options.failed ? "error" : "final_answer");
  trace.errorCode = options.errorCode ?? null;
  trace.uniqueTools.sort();

  return trace;
}

export function convergenceTraceToJSON(trace = {}) {
  return {
    status: trace.status ?? "running",
    maxToolIterations: trace.maxToolIterations ?? null,
    toolIterations: trace.toolIterations ?? 0,
    toolCalls: trace.toolCalls ?? 0,
    failedToolCalls: trace.failedToolCalls ?? 0,
    uniqueTools: Array.isArray(trace.uniqueTools) ? [...trace.uniqueTools] : [],
    compressedToolOutputs: trace.compressedToolOutputs ?? 0,
    budgetWarningInjected: Boolean(trace.budgetWarningInjected),
    repeatedToolWarningInjected: Boolean(trace.repeatedToolWarningInjected),
    repeatedToolCall: trace.repeatedToolCall ?? null,
    doneCriteriaCount: trace.doneCriteriaCount ?? 0,
    stopReason: trace.stopReason ?? null,
    errorCode: trace.errorCode ?? null
  };
}
