import { resolve } from "node:path";
import { createTurnContext } from "./core/turn-context.js";
import { MockTurnRuntime } from "./core/turn-runtime.js";
import { EVENT_TYPES, createThreadId, getItemText } from "./protocol/index.js";
import {
  appendTurnToSession,
  createSessionRecord,
  normalizeSessionRecord
} from "./session/history.js";
import { SessionStore } from "./session-store.js";
import { ToolRegistry } from "./tools/registry.js";

export class Thread {
  constructor(codexOptions = {}, threadOptions = {}, id) {
    this.codexOptions = codexOptions;
    this.threadOptions = threadOptions;
    this.id = id ?? createThreadId();
    this.workingDirectory = resolve(
      threadOptions.workingDirectory ??
      codexOptions.workingDirectory ??
      process.cwd()
    );
    this.sessionStore = new SessionStore({
      sessionStoreDirectory:
        threadOptions.sessionStoreDirectory ?? codexOptions.sessionStoreDirectory
    });
    this.toolRegistry = threadOptions.toolRegistry ?? codexOptions.toolRegistry ?? new ToolRegistry();
    this.runtime = threadOptions.runtime ?? codexOptions.runtime ?? new MockTurnRuntime({
      mockResponse: threadOptions.mockResponse ?? codexOptions.mockResponse
    });
  }

  async run(input, options = {}) {
    const events = [];
    const items = [];
    let finalResponse = "";
    let failed = false;
    let error = null;

    const streamed = await this.runStreamed(input, options);
    for await (const event of streamed.events) {
      events.push(event);

      if (event.item) {
        upsertItem(items, event.item);
      }

      if (
        event.type === EVENT_TYPES.ITEM_COMPLETED &&
        event.item?.role === "assistant"
      ) {
        finalResponse = getItemText(event.item);
      }

      if (event.type === EVENT_TYPES.TURN_FAILED) {
        failed = true;
        error = event.error;
      }
    }

    return {
      finalResponse,
      failed,
      error,
      items,
      events,
      threadId: this.id
    };
  }

  async runStreamed(input, options = {}) {
    const thread = this;
    const runtime = options.runtime ?? this.runtime;

    return {
      events: (async function* streamEvents() {
        const events = [];

        const turnContext = createTurnContext({
          threadId: thread.id,
          input,
          workingDirectory: thread.workingDirectory,
          tools: thread.toolRegistry.modelVisibleSpecs(),
          responseInputItems: await thread.responseInputItemsForNextTurn()
        });

        for await (const event of runtime.runTurn(turnContext)) {
          events.push(event);
          yield event;
        }

        await thread.persist(input, events);
      })()
    };
  }

  async load() {
    const session = await this.sessionStore.load(this.id);

    return session
      ? normalizeSessionRecord(session, {
          threadId: this.id,
          workingDirectory: this.workingDirectory
        })
      : null;
  }

  async ensureSession() {
    const existing = await this.load();

    if (existing) {
      return existing;
    }

    const session = createSessionRecord({
      threadId: this.id,
      workingDirectory: this.workingDirectory
    });

    await this.sessionStore.save(session);
    return session;
  }

  async persist(input, events) {
    const existing = await this.load();
    const session = appendTurnToSession(existing ?? {
      threadId: this.id,
      workingDirectory: this.workingDirectory
    }, {
      input,
      events
    }, {
      threadId: this.id,
      workingDirectory: this.workingDirectory,
      compaction: this.threadOptions.compaction ?? this.codexOptions.compaction
    });

    await this.sessionStore.save(session);
    return session;
  }

  async responseInputItemsForNextTurn() {
    const session = await this.load();

    return session?.responseInputItems ?? [];
  }

  async injectResponseItems(items = [], options = {}) {
    await this.ensureSession();

    return await this.sessionStore.injectResponseItems(this.id, items, {
      compaction: options.compaction ?? this.threadOptions.compaction ?? this.codexOptions.compaction,
      threadId: this.id,
      workingDirectory: this.workingDirectory
    });
  }
}

function upsertItem(items, item) {
  const index = items.findIndex((candidate) => candidate.id === item.id);

  if (index === -1) {
    items.push(item);
    return;
  }

  items[index] = item;
}
