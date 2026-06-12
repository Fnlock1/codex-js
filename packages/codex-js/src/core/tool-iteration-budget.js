export const DEFAULT_MAX_TOOL_ITERATIONS = 12;
export const DEFAULT_TOOL_ITERATION_WARNING_REMAINING = 2;

export function createToolIterationBudget(options = {}) {
  const maxIterations = normalizePositiveInteger(
    options.maxIterations ?? options.maxToolIterations,
    DEFAULT_MAX_TOOL_ITERATIONS
  );
  const warningRemaining = Math.min(
    maxIterations,
    normalizeNonNegativeInteger(
      options.warningRemaining ?? options.warningThreshold,
      DEFAULT_TOOL_ITERATION_WARNING_REMAINING
    )
  );

  return {
    maxIterations,
    warningRemaining
  };
}

export function toolIterationState(iteration, budget = createToolIterationBudget()) {
  const currentIteration = normalizeNonNegativeInteger(iteration, 0);
  const maxIterations = normalizePositiveInteger(
    budget.maxIterations ?? budget.maxToolIterations,
    DEFAULT_MAX_TOOL_ITERATIONS
  );
  const warningRemaining = Math.min(
    maxIterations,
    normalizeNonNegativeInteger(
      budget.warningRemaining ?? budget.warningThreshold,
      DEFAULT_TOOL_ITERATION_WARNING_REMAINING
    )
  );
  const remainingBeforeHardLimit = Math.max(0, maxIterations - currentIteration);

  return {
    iteration: currentIteration,
    maxIterations,
    warningRemaining,
    remainingBeforeHardLimit,
    shouldWarn: remainingBeforeHardLimit <= warningRemaining,
    isFinalIteration: remainingBeforeHardLimit === 0
  };
}

export function formatToolIterationWarning(state = {}) {
  const remaining = Number.isSafeInteger(state.remainingBeforeHardLimit)
    ? state.remainingBeforeHardLimit
    : 0;
  const maxIterations = Number.isSafeInteger(state.maxIterations)
    ? state.maxIterations
    : DEFAULT_MAX_TOOL_ITERATIONS;

  if (remaining <= 0) {
    return [
      `Tool iteration budget is exhausted (${maxIterations} max tool iterations).`,
      "Do not call another tool. Provide the best final answer now, including what is done, what is unverified, and any next step."
    ].join(" ");
  }

  return [
    `Tool iteration budget is almost exhausted (${remaining} tool iteration${remaining === 1 ? "" : "s"} left before the ${maxIterations} limit).`,
    "Stop exploring. Only call a tool if it is required to finish safely; otherwise provide the final answer with validation status and residual risk."
  ].join(" ");
}

export function createToolIterationLimitError(state = {}) {
  const maxIterations = Number.isSafeInteger(state.maxIterations)
    ? state.maxIterations
    : DEFAULT_MAX_TOOL_ITERATIONS;
  const error = new Error(
    `Tool iteration limit reached after ${maxIterations} tool iterations. The agent kept calling tools instead of finishing, so the turn was stopped to avoid an unbounded loop.`
  );

  error.code = "tool_iteration_limit";
  error.details = {
    maxToolIterations: maxIterations,
    iteration: Number.isSafeInteger(state.iteration) ? state.iteration : maxIterations,
    reason: "The model did not produce a final answer before the tool-call budget was exhausted.",
    recovery: "Split the task into a smaller step, raise maxToolIterations, or improve planner/context instructions so the agent summarizes and stops earlier."
  };

  return error;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);

  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  const number = Number(value);

  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}
