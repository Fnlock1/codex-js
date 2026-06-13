import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MAX_TOOL_ITERATIONS,
  createToolIterationBudget,
  createToolIterationLimitError,
  formatToolIterationWarning,
  toolIterationState
} from "../src/index.js";

test("tool iteration budget normalizes invalid options", () => {
  const budget = createToolIterationBudget({
    maxToolIterations: -1,
    warningRemaining: -1
  });

  assert.equal(budget.maxIterations, DEFAULT_MAX_TOOL_ITERATIONS);
  assert.equal(budget.warningRemaining, 2);
});

test("tool iteration state reports remaining budget and warnings", () => {
  const budget = createToolIterationBudget({
    maxToolIterations: 5,
    warningRemaining: 2
  });

  assert.deepEqual(toolIterationState(2, budget), {
    iteration: 2,
    maxIterations: 5,
    warningRemaining: 2,
    remainingBeforeHardLimit: 3,
    shouldWarn: false,
    isFinalIteration: false
  });
  assert.equal(toolIterationState(3, budget).shouldWarn, true);
  assert.equal(toolIterationState(5, budget).isFinalIteration, true);
});

test("tool iteration warning asks the model to converge", () => {
  const warning = formatToolIterationWarning(toolIterationState(4, {
    maxIterations: 5,
    warningRemaining: 2
  }));

  assert.match(warning, /almost exhausted/u);
  assert.match(warning, /Stop exploring/u);
});

test("tool iteration limit error includes actionable details", () => {
  const error = createToolIterationLimitError(toolIterationState(5, {
    maxIterations: 5,
    warningRemaining: 2
  }));

  assert.equal(error.code, "tool_iteration_limit");
  assert.equal(error.details.maxToolIterations, 5);
  assert.match(error.message, /Tool iteration limit reached/u);
  assert.match(error.details.recovery, /Split the task/u);
});
