import { resolve } from "node:path";
import { createThreadId, normalizeUserInput, userInputToText } from "../protocol/index.js";

export class TurnContext {
  constructor(options = {}) {
    this.threadId = options.threadId ?? createThreadId();
    this.input = normalizeUserInput(options.input ?? "");
    this.workingDirectory = resolve(options.workingDirectory ?? process.cwd());
    this.tools = Array.isArray(options.tools) ? options.tools : [];
    this.responseInputItems = Array.isArray(options.responseInputItems)
      ? options.responseInputItems
      : [];
    this.history = Array.isArray(options.history) ? options.history : [];
    this.metadata = {
      startedAt: options.startedAt ?? new Date().toISOString(),
      source: options.source ?? "codex-js",
      ...(options.metadata ?? {})
    };
  }

  inputText() {
    return userInputToText(this.input);
  }

  toJSON() {
    return {
      thread_id: this.threadId,
      input: this.input,
      working_directory: this.workingDirectory,
      tools: this.tools,
      response_input_items: this.responseInputItems,
      history: this.history,
      metadata: this.metadata
    };
  }
}

export function createTurnContext(options = {}) {
  return new TurnContext(options);
}
