import { Thread } from "./thread.js";

export class Codex {
  constructor(options = {}) {
    this.options = { ...options };
  }

  startThread(options = {}) {
    return new Thread(this.options, options);
  }

  resumeThread(id, options = {}) {
    return new Thread(this.options, options, id);
  }
}
