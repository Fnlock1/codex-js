import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createToolCallSignature,
  createToolLoopDetector,
  formatRepeatedToolCallWarning
} from "../src/index.js";

test("tool loop detector creates stable signatures for reordered object arguments", () => {
  assert.equal(
    createToolCallSignature({
      name: "read_file",
      arguments: {
        b: 2,
        a: 1
      }
    }),
    createToolCallSignature({
      name: "read_file",
      arguments: {
        a: 1,
        b: 2
      }
    })
  );
});

test("tool loop detector flags repeated identical tool calls", () => {
  const detector = createToolLoopDetector({
    threshold: 3
  });
  const call = {
    name: "search_files",
    arguments: {
      query: "needle"
    }
  };

  assert.equal(detector.record(call).repeated, false);
  assert.equal(detector.record(call).repeated, false);
  const result = detector.record(call);

  assert.equal(result.repeated, true);
  assert.equal(result.repeatedCount, 3);
  assert.equal(result.toolName, "search_files");
});

test("tool loop detector requires consecutive repeated calls", () => {
  const detector = createToolLoopDetector({
    threshold: 2
  });

  assert.equal(detector.record({
    name: "search_files",
    arguments: {
      query: "a"
    }
  }).repeated, false);
  assert.equal(detector.record({
    name: "search_files",
    arguments: {
      query: "b"
    }
  }).repeated, false);
  assert.equal(detector.record({
    name: "search_files",
    arguments: {
      query: "a"
    }
  }).repeated, false);
});

test("repeated tool warning asks the model to stop repeating", () => {
  const warning = formatRepeatedToolCallWarning({
    toolName: "read_file",
    threshold: 3
  });

  assert.match(warning, /Repeated tool-call pattern detected/u);
  assert.match(warning, /Stop repeating/u);
});
