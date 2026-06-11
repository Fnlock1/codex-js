/**
 * 中文模块说明：src/core/react-trace.js
 *
 * agent turn 上下文、模型调用抽象、工具循环和 ReAct trace。
 */
export const REACT_STEP_STATUSES = Object.freeze({
  STARTED: "started",
  OBSERVED: "observed",
  COMPLETED: "completed",
  FAILED: "failed"
});

/**
 * 创建 create react trace 相关数据。
 * @returns {unknown} 返回处理后的结果。
 */
export function createReactTrace() {
  return [];
}

/**
 * 创建 create react step 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 追加 append react thought 相关数据。
 *
 * @param {unknown} trace - trace 参数。
 * @param {unknown} thought - thought 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 追加 append react action 相关数据。
 *
 * @param {unknown} trace - trace 参数。
 * @param {unknown} action - action 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 完成 complete react action 相关数据。
 *
 * @param {unknown} step - step 参数。
 * @param {unknown} observation - observation 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function completeReactAction(step, observation, options = {}) {
  step.status = options.failed ? REACT_STEP_STATUSES.FAILED : REACT_STEP_STATUSES.OBSERVED;
  step.observation = observation == null ? null : String(observation);
  step.error = options.error ?? null;
  return step;
}

/**
 * 完成 complete react trace 相关数据。
 *
 * @param {unknown} trace - trace 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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

/**
 * 处理 react trace to json 相关逻辑。
 *
 * @param {unknown} trace - trace 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function reactTraceToJSON(trace = []) {
  return trace.map((step) => ({ ...step }));
}

/**
 * 归一化 normalize thought text 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
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
