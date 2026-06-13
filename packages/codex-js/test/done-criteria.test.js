import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_DONE_CRITERIA,
  createDoneCriteriaMessage,
  normalizeDoneCriteria
} from "../src/index.js";

test("normalizeDoneCriteria falls back to defaults", () => {
  assert.deepEqual(normalizeDoneCriteria([]), [...DEFAULT_DONE_CRITERIA]);
  assert.deepEqual(normalizeDoneCriteria(["  finish ", "", null]), ["finish"]);
});

test("createDoneCriteriaMessage formats numbered stop conditions", () => {
  const message = createDoneCriteriaMessage([
    "Edit the requested file.",
    "Run the focused test."
  ]);

  assert.match(message, /Done criteria:/u);
  assert.match(message, /1\. Edit the requested file\./u);
  assert.match(message, /2\. Run the focused test\./u);
  assert.match(message, /produce the final answer/u);
});
