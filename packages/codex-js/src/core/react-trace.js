export const REACT_STEP_STATUSES = Object.freeze({
  STARTED: "started",
  OBSERVED: "observed",
  COMPLETED: "completed",
  FAILED: "failed"
});

export function createReactTrace() {
  return [];
}

export function createReactStep(options = {}) {
  return {
    index: Number(options.index ?? 0),
    status: options.status ?? REACT_STEP_STATUSES.STARTED,
    thought: options.thought ?? null,
    action: options.action ?? null,
    action_input: options.actionInput ?? options.action_input ?? null,
    observation: options.observation ?? null,
    error: options.error ?? null
  };
}

export function appendReactThought(trace, thought, options = {}) {
  const text = normalizeThoughtText(thought);

  if (!text) {
    return trace;
  }

  const step = createReactStep({
    index: trace.length,
    status: options.status ?? REACT_STEP_STATUSES.STARTED,
    thought: text
  });

  trace.push(step);
  return trace;
}

export function appendReactAction(trace, action, options = {}) {
  const step = createReactStep({
    index: trace.length,
    status: options.status ?? REACT_STEP_STATUSES.STARTED,
    thought: options.thought ?? null,
    action: action?.name ?? action?.action ?? null,
    actionInput: action?.arguments ?? action?.action_input ?? action?.input ?? null
  });

  trace.push(step);
  return step;
}

export function completeReactAction(step, observation, options = {}) {
  step.status = options.failed ? REACT_STEP_STATUSES.FAILED : REACT_STEP_STATUSES.OBSERVED;
  step.observation = observation == null ? null : String(observation);
  step.error = options.error ?? null;
  return step;
}

export function completeReactTrace(trace, options = {}) {
  if (trace.length === 0) {
    return trace;
  }

  const last = trace.at(-1);

  if (last && last.status === REACT_STEP_STATUSES.STARTED) {
    last.status = options.failed ? REACT_STEP_STATUSES.FAILED : REACT_STEP_STATUSES.COMPLETED;
  }

  return trace;
}

export function reactTraceToJSON(trace = []) {
  return trace.map((step) => ({ ...step }));
}

function normalizeThoughtText(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => entry?.text ?? entry)
      .filter(Boolean)
      .map(String)
      .join("\n");
  }

  if (value && typeof value === "object") {
    return String(value.text ?? value.summaryText ?? value.summary_text ?? "");
  }

  return String(value ?? "");
}
