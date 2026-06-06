import { EVENT_TYPES, getItemText } from "../protocol/index.js";

export const CODEX_STATUS = Object.freeze({
  RUNNING: "running",
  INITIATE_SHUTDOWN: "initiate_shutdown"
});

export class JsonlExecEventProcessor {
  constructor(output) {
    this.output = output;
    this.finalMessage = null;
  }

  processEvent(event) {
    this.captureFinalMessage(event);
    this.output.write(`${JSON.stringify(event)}\n`);
    return statusForEvent(event);
  }

  processWarning(message) {
    this.output.write(`${JSON.stringify({
      type: EVENT_TYPES.ERROR,
      message: String(message)
    })}\n`);
    return CODEX_STATUS.RUNNING;
  }

  printFinalOutput() {}

  captureFinalMessage(event) {
    if (
      event.type === EVENT_TYPES.ITEM_COMPLETED &&
      event.item?.role === "assistant"
    ) {
      this.finalMessage = getItemText(event.item);
    }
  }
}

export class HumanExecEventProcessor {
  constructor(output) {
    this.output = output;
    this.finalMessage = null;
    this.finalMessageRendered = false;
  }

  processEvent(event) {
    if (event.type === EVENT_TYPES.TURN_FAILED) {
      this.renderTurnFailed(event.error);
    }

    if (event.type === EVENT_TYPES.ERROR) {
      this.renderError(event);
    }

    if (event.type === EVENT_TYPES.ITEM_STARTED) {
      this.renderItemStarted(event.item);
    }

    if (event.type === EVENT_TYPES.ITEM_COMPLETED) {
      this.renderItemCompleted(event.item);
    }

    return statusForEvent(event);
  }

  processWarning(message) {
    this.output.write(`warning: ${String(message)}\n`);
    return CODEX_STATUS.RUNNING;
  }

  printFinalOutput() {
    if (this.finalMessage && !this.finalMessageRendered) {
      this.output.write(`${this.finalMessage}\n`);
      this.finalMessageRendered = true;
    }
  }

  renderItemStarted(item) {
    if (item?.type === "command_execution") {
      const cwd = item.cwd ? ` in ${item.cwd}` : "";
      this.output.write(`exec\n${item.command}${cwd}\n`);
    }
  }

  renderTurnFailed(error) {
    this.output.write(`turn failed: ${error?.message ?? "unknown error"}\n`);
  }

  renderError(event) {
    this.output.write(`error: ${event.message ?? "unknown error"}\n`);
  }

  renderItemCompleted(item) {
    if (item?.role === "assistant") {
      this.finalMessage = getItemText(item);
      this.output.write(`${this.finalMessage}\n`);
      this.finalMessageRendered = true;
      return;
    }

    if (item?.type === "command_execution") {
      const status = item.status === "completed" ? "succeeded" : item.status;
      this.output.write(`${status}:\n`);

      if (item.aggregated_output) {
        this.output.write(`${item.aggregated_output}\n`);
      }
    }
  }
}

export async function processEventStream(events, processor) {
  let status = CODEX_STATUS.RUNNING;

  for await (const event of events) {
    status = processor.processEvent(event);
  }

  processor.printFinalOutput();
  return status;
}

export function createExecEventProcessor({ json, stdout, stderr }) {
  return json
    ? new JsonlExecEventProcessor(stdout)
    : new HumanExecEventProcessor(stderr ?? stdout);
}

function statusForEvent(event) {
  if (
    event.type === EVENT_TYPES.TURN_COMPLETED ||
    event.type === EVENT_TYPES.TURN_FAILED ||
    event.type === EVENT_TYPES.ERROR
  ) {
    return CODEX_STATUS.INITIATE_SHUTDOWN;
  }

  return CODEX_STATUS.RUNNING;
}
