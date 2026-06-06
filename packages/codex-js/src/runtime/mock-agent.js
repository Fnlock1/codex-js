import { MockTurnRuntime, defaultMockResponse } from "../core/turn-runtime.js";
import { userInputToText } from "../protocol/index.js";

export class MockAgentRuntime extends MockTurnRuntime {}

export function normalizeInput(input) {
  return userInputToText(input);
}

export { defaultMockResponse };
