/**
 * Output compression keeps model-facing tool results compact while preserving
 * enough metadata for callers to audit the original size.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compressToolOutput,
  createOutputSummary
} from "../src/index.js";

test("createOutputSummary reports short output without compression", () => {
  const summary = createOutputSummary("alpha\nbeta", {
    maxChars: 100,
    maxLines: 10
  });

  assert.deepEqual(summary, {
    compressed: false,
    originalChars: 10,
    originalLines: 2,
    maxChars: 100,
    maxLines: 10,
    reason: null
  });
});

test("compressToolOutput leaves short output unchanged", () => {
  const result = compressToolOutput("small result", {
    maxChars: 100,
    maxLines: 10
  });

  assert.equal(result.text, "small result");
  assert.equal(result.summary.compressed, false);
  assert.equal(result.summary.originalChars, 12);
});

test("compressToolOutput compresses long character output with head and tail", () => {
  const result = compressToolOutput(`${"a".repeat(20)}${"b".repeat(20)}${"z".repeat(20)}`, {
    maxChars: 30,
    headChars: 8,
    tailChars: 8,
    maxLines: 100,
    notice: "[cut]"
  });

  assert.equal(result.summary.compressed, true);
  assert.equal(result.summary.reason, "chars");
  assert.equal(result.summary.originalChars, 60);
  assert.match(result.text, /^aaaaaaaa\n\[cut\]\nzzzzzzzz$/u);
  assert.equal(result.summary.compressedChars, result.text.length);
});

test("compressToolOutput compresses many-line output with head and tail", () => {
  const text = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n");
  const result = compressToolOutput(text, {
    maxChars: 1_000,
    maxLines: 5,
    headLines: 2,
    tailLines: 2,
    notice: "[cut]"
  });

  assert.equal(result.summary.compressed, true);
  assert.equal(result.summary.reason, "lines");
  assert.equal(result.summary.originalLines, 12);
  assert.equal(result.text, "line-1\nline-2\n[cut]\nline-11\nline-12");
  assert.equal(result.summary.compressedLines, 5);
});

test("compressToolOutput records combined compression reasons", () => {
  const text = Array.from({ length: 10 }, () => "0123456789").join("\n");
  const result = compressToolOutput(text, {
    maxChars: 20,
    headChars: 5,
    tailChars: 5,
    maxLines: 3,
    headLines: 1,
    tailLines: 1,
    notice: "[cut]"
  });

  assert.equal(result.summary.compressed, true);
  assert.equal(result.summary.reason, "chars+lines");
  assert.equal(result.summary.originalChars, 109);
  assert.equal(result.summary.originalLines, 10);
  assert.match(result.text, /\[cut\]/u);
});
