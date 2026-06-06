export const THREAD_GOAL_STATUSES = Object.freeze({
  ACTIVE: "active",
  PAUSED: "paused",
  BLOCKED: "blocked",
  USAGE_LIMITED: "usageLimited",
  BUDGET_LIMITED: "budgetLimited",
  COMPLETE: "complete"
});

const THREAD_GOAL_STATUS_SET = new Set(Object.values(THREAD_GOAL_STATUSES));

export function createThreadGoal(options = {}) {
  const now = unixSeconds(options.now ?? Date.now());
  const existing = options.existing ?? {};
  const objective = normalizeGoalObjective(
    options.objective ?? existing.objective
  );

  return {
    threadId: String(options.threadId ?? existing.threadId ?? ""),
    objective,
    status: normalizeThreadGoalStatus(options.status ?? existing.status),
    tokenBudget: normalizeOptionalNonNegativeInteger(options.tokenBudget ?? existing.tokenBudget),
    tokensUsed: normalizeNonNegativeInteger(options.tokensUsed ?? existing.tokensUsed, 0),
    timeUsedSeconds: normalizeNonNegativeInteger(options.timeUsedSeconds ?? existing.timeUsedSeconds, 0),
    createdAt: normalizeUnixSeconds(existing.createdAt, now),
    updatedAt: now
  };
}

export function normalizeThreadGoal(value, options = {}) {
  if (!value) {
    return null;
  }

  return createThreadGoal({
    threadId: options.threadId ?? value.threadId,
    objective: value.objective,
    status: value.status,
    tokenBudget: value.tokenBudget ?? value.token_budget,
    tokensUsed: value.tokensUsed ?? value.tokens_used,
    timeUsedSeconds: value.timeUsedSeconds ?? value.time_used_seconds,
    existing: {
      threadId: options.threadId ?? value.threadId,
      objective: value.objective,
      status: value.status,
      tokenBudget: value.tokenBudget ?? value.token_budget,
      tokensUsed: value.tokensUsed ?? value.tokens_used,
      timeUsedSeconds: value.timeUsedSeconds ?? value.time_used_seconds,
      createdAt: value.createdAt ?? value.created_at,
      updatedAt: value.updatedAt ?? value.updated_at
    },
    now: value.updatedAt ?? value.updated_at ?? Date.now()
  });
}

export function normalizeThreadGoalStatus(value) {
  const status = String(value ?? THREAD_GOAL_STATUSES.ACTIVE);

  return THREAD_GOAL_STATUS_SET.has(status)
    ? status
    : THREAD_GOAL_STATUSES.ACTIVE;
}

export function normalizeGoalObjective(value) {
  const objective = String(value ?? "").trim();

  if (!objective) {
    throw new Error("thread goal objective must be a non-empty string");
  }

  return objective;
}

function normalizeOptionalNonNegativeInteger(value) {
  if (value == null || value === "") {
    return null;
  }

  return normalizeNonNegativeInteger(value, null);
}

function normalizeNonNegativeInteger(value, fallback) {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < 0) {
    return fallback;
  }

  return number;
}

function normalizeUnixSeconds(value, fallback) {
  const number = Number(value);

  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function unixSeconds(value) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    return Math.floor(Date.now() / 1000);
  }

  return number > 10_000_000_000
    ? Math.floor(number / 1000)
    : Math.floor(number);
}
