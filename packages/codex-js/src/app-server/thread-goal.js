/**
 * 中文模块说明：src/app-server/thread-goal.js
 *
 * 面向 UI 或守护进程的 JSONL/RPC app-server 协议层。
 */
export const THREAD_GOAL_STATUSES = Object.freeze({
  ACTIVE: "active",
  PAUSED: "paused",
  BLOCKED: "blocked",
  USAGE_LIMITED: "usageLimited",
  BUDGET_LIMITED: "budgetLimited",
  COMPLETE: "complete"
});

const THREAD_GOAL_STATUS_SET = new Set(Object.values(THREAD_GOAL_STATUSES));

/**
 * 创建 create thread goal 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 归一化 normalize thread goal 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 归一化 normalize thread goal status 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeThreadGoalStatus(value) {
  const status = String(value ?? THREAD_GOAL_STATUSES.ACTIVE);

  return THREAD_GOAL_STATUS_SET.has(status)
    ? status
    : THREAD_GOAL_STATUSES.ACTIVE;
}

/**
 * 归一化 normalize goal objective 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeGoalObjective(value) {
  const objective = String(value ?? "").trim();

  if (!objective) {
    throw new Error("thread goal objective must be a non-empty string");
  }

  return objective;
}

/**
 * 归一化 normalize optional non negative integer 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeOptionalNonNegativeInteger(value) {
  if (value == null || value === "") {
    return null;
  }

  return normalizeNonNegativeInteger(value, null);
}

/**
 * 归一化 normalize non negative integer 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @param {unknown} fallback - fallback 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeNonNegativeInteger(value, fallback) {
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < 0) {
    return fallback;
  }

  return number;
}

/**
 * 归一化 normalize unix seconds 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @param {unknown} fallback - fallback 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeUnixSeconds(value, fallback) {
  const number = Number(value);

  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

/**
 * 处理 unix seconds 相关逻辑。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function unixSeconds(value) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    return Math.floor(Date.now() / 1000);
  }

  return number > 10_000_000_000
    ? Math.floor(number / 1000)
    : Math.floor(number);
}
