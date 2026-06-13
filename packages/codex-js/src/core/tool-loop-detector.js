export const DEFAULT_REPEATED_TOOL_CALL_THRESHOLD = 3;

export function createToolLoopDetector(options = {}) {
  return new ToolLoopDetector(options);
}

export class ToolLoopDetector {
  constructor(options = {}) {
    this.threshold = normalizePositiveInteger(
      options.threshold ?? options.repeatedToolCallThreshold,
      DEFAULT_REPEATED_TOOL_CALL_THRESHOLD
    );
    this.lastSignature = null;
    this.repeatedCount = 0;
  }

  record(toolCall = {}) {
    const signature = createToolCallSignature(toolCall);

    if (signature === this.lastSignature) {
      this.repeatedCount += 1;
    } else {
      this.lastSignature = signature;
      this.repeatedCount = 1;
    }

    const repeated = this.repeatedCount >= this.threshold;

    return {
      repeated,
      repeatedCount: this.repeatedCount,
      threshold: this.threshold,
      signature,
      toolName: String(toolCall.name ?? "")
    };
  }
}

export function createToolCallSignature(toolCall = {}) {
  return [
    String(toolCall.name ?? ""),
    stableStringify(toolCall.arguments ?? toolCall.input ?? {})
  ].join(":");
}

export function formatRepeatedToolCallWarning(result = {}) {
  const toolName = result.toolName || "the same tool";
  const threshold = Number.isSafeInteger(result.threshold)
    ? result.threshold
    : DEFAULT_REPEATED_TOOL_CALL_THRESHOLD;

  return [
    `Repeated tool-call pattern detected: ${toolName} was called with the same arguments ${threshold} times.`,
    "Stop repeating the same tool call. Use the evidence already available, explain any uncertainty, and produce the final answer unless a different tool call is strictly required."
  ].join(" ");
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }

  return JSON.stringify(value);
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);

  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
