/**
 * 中文模块说明：src/protocol/exec-output.js
 *
 * thread、turn、item、user input、permission 等公共协议对象。
 */
export function createStreamOutput(text = "", options = {}) {
  return {
    text: String(text),
    truncated_after_lines: options.truncatedAfterLines ?? null
  };
}

/**
 * 创建 create exec tool call output 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createExecToolCallOutput(options = {}) {
  const stdout = normalizeStreamOutput(options.stdout);
  const stderr = normalizeStreamOutput(options.stderr);
  const aggregatedOutput = options.aggregatedOutput
    ? normalizeStreamOutput(options.aggregatedOutput)
    : createStreamOutput(`${stdout.text}${stderr.text}`);

  return {
    exit_code: options.exitCode ?? 0,
    stdout,
    stderr,
    aggregated_output: aggregatedOutput,
    duration_ms: options.durationMs ?? 0,
    timed_out: options.timedOut ?? false
  };
}

/**
 * 归一化 normalize stream output 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeStreamOutput(value) {
  if (value && typeof value === "object" && typeof value.text === "string") {
    return {
      text: value.text,
      truncated_after_lines: value.truncated_after_lines ?? value.truncatedAfterLines ?? null
    };
  }

  return createStreamOutput(value ?? "");
}
