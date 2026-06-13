export const TOOL_OUTPUT_COMPRESSION_DEFAULTS = Object.freeze({
  MAX_CHARS: 12_000,
  HEAD_CHARS: 6_000,
  TAIL_CHARS: 4_000,
  MAX_LINES: 240,
  HEAD_LINES: 140,
  TAIL_LINES: 80,
  NOTICE: "[... tool output compressed ...]"
});

export function createOutputSummary(output, options = {}) {
  const text = String(output ?? "");
  const lines = text ? text.split(/\r?\n/u) : [];
  const maxChars = normalizePositiveInteger(options.maxChars, TOOL_OUTPUT_COMPRESSION_DEFAULTS.MAX_CHARS);
  const maxLines = normalizePositiveInteger(options.maxLines, TOOL_OUTPUT_COMPRESSION_DEFAULTS.MAX_LINES);
  const truncatedByChars = text.length > maxChars;
  const truncatedByLines = lines.length > maxLines;
  const compressed = truncatedByChars || truncatedByLines;

  return {
    compressed,
    originalChars: text.length,
    originalLines: lines.length,
    maxChars,
    maxLines,
    reason: compressed
      ? [
          truncatedByChars ? "chars" : null,
          truncatedByLines ? "lines" : null
        ].filter(Boolean).join("+")
      : null
  };
}

export function compressToolOutput(output, options = {}) {
  const text = String(output ?? "");
  const summary = createOutputSummary(text, options);

  if (!summary.compressed) {
    return {
      text,
      summary
    };
  }

  const notice = String(options.notice ?? TOOL_OUTPUT_COMPRESSION_DEFAULTS.NOTICE);
  const byLines = compressByLines(text, {
    maxLines: options.maxLines,
    headLines: options.headLines,
    tailLines: options.tailLines,
    notice
  });
  const byChars = compressByChars(byLines, {
    maxChars: options.maxChars,
    headChars: options.headChars,
    tailChars: options.tailChars,
    notice
  });

  return {
    text: byChars,
    summary: {
      ...summary,
      compressedChars: byChars.length,
      compressedLines: byChars ? byChars.split(/\r?\n/u).length : 0
    }
  };
}

function compressByLines(text, options = {}) {
  const lines = text.split(/\r?\n/u);
  const maxLines = normalizePositiveInteger(options.maxLines, TOOL_OUTPUT_COMPRESSION_DEFAULTS.MAX_LINES);

  if (lines.length <= maxLines) {
    return text;
  }

  const headLines = normalizePositiveInteger(options.headLines, TOOL_OUTPUT_COMPRESSION_DEFAULTS.HEAD_LINES);
  const tailLines = normalizePositiveInteger(options.tailLines, TOOL_OUTPUT_COMPRESSION_DEFAULTS.TAIL_LINES);
  const notice = String(options.notice ?? TOOL_OUTPUT_COMPRESSION_DEFAULTS.NOTICE);
  const head = lines.slice(0, headLines);
  const tail = lines.slice(Math.max(headLines, lines.length - tailLines));

  return [
    ...head,
    notice,
    ...tail
  ].join("\n");
}

function compressByChars(text, options = {}) {
  const maxChars = normalizePositiveInteger(options.maxChars, TOOL_OUTPUT_COMPRESSION_DEFAULTS.MAX_CHARS);

  if (text.length <= maxChars) {
    return text;
  }

  const headChars = normalizePositiveInteger(options.headChars, TOOL_OUTPUT_COMPRESSION_DEFAULTS.HEAD_CHARS);
  const tailChars = normalizePositiveInteger(options.tailChars, TOOL_OUTPUT_COMPRESSION_DEFAULTS.TAIL_CHARS);
  const notice = String(options.notice ?? TOOL_OUTPUT_COMPRESSION_DEFAULTS.NOTICE);
  const head = text.slice(0, headChars);
  const tail = text.slice(Math.max(headChars, text.length - tailChars));

  return `${head}${head.endsWith("\n") ? "" : "\n"}${notice}\n${tail}`;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);

  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
