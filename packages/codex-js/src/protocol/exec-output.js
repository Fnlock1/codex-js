export function createStreamOutput(text = "", options = {}) {
  return {
    text: String(text),
    truncated_after_lines: options.truncatedAfterLines ?? null
  };
}

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

export function normalizeStreamOutput(value) {
  if (value && typeof value === "object" && typeof value.text === "string") {
    return {
      text: value.text,
      truncated_after_lines: value.truncated_after_lines ?? value.truncatedAfterLines ?? null
    };
  }

  return createStreamOutput(value ?? "");
}
