/**
 * 中文模块说明：src/thread.js
 *
 * 线程/会话执行入口，串联输入、运行时事件流和历史持久化。
 */
import { resolve } from "node:path";
import { createTurnContext } from "./core/turn-context.js";
import { MockTurnRuntime } from "./core/turn-runtime.js";
import { EVENT_TYPES, createThreadId, getItemText, userInputToText } from "./protocol/index.js";
import { MemoryStore, formatRecalledMemories } from "./memory/store.js";
import {
  appendTurnToSession,
  createSessionRecord,
  normalizeSessionRecord
} from "./session/history.js";
import { SessionStore } from "./session-store.js";
import { ToolRegistry } from "./tools/registry.js";

/**
 * 一个可持续多轮执行的 agent 会话。
 *
 * Thread 负责把用户输入、工作目录、工具列表、历史 response input items
 * 组装成 TurnContext，然后交给 runtime 执行，并在 turn 结束后持久化事件。
 */
export class Thread {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} codexOptions - codexOptions 参数。
   * @param {unknown} threadOptions - threadOptions 参数。
   * @param {unknown} id - id 参数。
   */
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
    this.memoryStore = threadOptions.memoryStore ?? codexOptions.memoryStore ?? new MemoryStore({
      memoryStoreDirectory:
        threadOptions.memoryStoreDirectory ?? codexOptions.memoryStoreDirectory
    });
    this.memoryOptions = {
      enabled: threadOptions.memory?.enabled ?? codexOptions.memory?.enabled ?? true,
      limit: threadOptions.memory?.limit ?? codexOptions.memory?.limit,
      scope: threadOptions.memory?.scope ?? codexOptions.memory?.scope,
      expertId:
        threadOptions.memory?.expertId ??
        threadOptions.memory?.expert_id ??
        codexOptions.memory?.expertId ??
        codexOptions.memory?.expert_id ??
        null
    };
    this.toolRegistry = threadOptions.toolRegistry ?? codexOptions.toolRegistry ?? new ToolRegistry();
    this.toolVisibility = {
      expertTeam:
        threadOptions.toolVisibility?.expertTeam ??
        codexOptions.toolVisibility?.expertTeam ??
        false
    };
    this.runtime = threadOptions.runtime ?? codexOptions.runtime ?? new MockTurnRuntime({
      mockResponse: threadOptions.mockResponse ?? codexOptions.mockResponse
    });
  }

  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} input - input 参数。
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
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

  /**
   * 以流式事件方式执行一轮输入。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} input - input 参数。
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async runStreamed(input, options = {}) {
    const thread = this;
    const runtime = options.runtime ?? this.runtime;

    return {
      events: (async function* streamEvents() {
        const events = [];
        const recalledMemories = await thread.recallMemoriesForInput(input, options);

        const turnContext = createTurnContext({
          threadId: thread.id,
          input,
          workingDirectory: thread.workingDirectory,
          tools: thread.toolRegistry.modelVisibleSpecs(thread.toolVisibility),
          responseInputItems: await thread.responseInputItemsForNextTurn(),
          memories: recalledMemories,
          memoryContextText: formatRecalledMemories(recalledMemories),
          metadata: {
            memory: {
              recalled: recalledMemories,
              expertId: thread.memoryOptions.expertId
            }
          }
        });

        for await (const event of runtime.runTurn(turnContext)) {
          events.push(event);
          yield event;
        }

        await thread.persist(input, events);
      })()
    };
  }

  /**
   * 加载 load 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
  async load() {
    const session = await this.sessionStore.load(this.id);

    return session
      ? normalizeSessionRecord(session, {
          threadId: this.id,
          workingDirectory: this.workingDirectory
        })
      : null;
  }

  /**
   * 处理 ensure session 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
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

  /**
   * 处理 persist 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} input - input 参数。
   * @param {unknown} events - events 参数。
   * @returns {unknown} 返回处理后的结果。
   */
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

  /**
   * 处理 response input items for next turn 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
  async responseInputItemsForNextTurn() {
    const session = await this.load();

    return session?.responseInputItems ?? [];
  }

  /**
   * 根据当前用户输入召回长期记忆。
   *
   * @param {unknown} input - 当前 turn 的用户输入。
   * @param {object} options - 本轮运行选项。
   * @returns {Promise<object[]>} 可注入 prompt 的记忆列表。
   */
  async recallMemoriesForInput(input, options = {}) {
    if (options.memory?.enabled === false || this.memoryOptions.enabled === false) {
      return [];
    }

    const limit = options.memory?.limit ?? this.memoryOptions.limit;
    const scope = options.memory?.scope ?? this.memoryOptions.scope;
    const expertId = options.memory?.expertId ?? options.memory?.expert_id ?? this.memoryOptions.expertId;

    return await this.memoryStore.recall(userInputToText(input), {
      threadId: this.id,
      workingDirectory: this.workingDirectory,
      limit,
      scope,
      expertId
    });
  }

  /**
   * 处理 inject response items 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} items - items 参数。
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async injectResponseItems(items = [], options = {}) {
    await this.ensureSession();

    return await this.sessionStore.injectResponseItems(this.id, items, {
      compaction: options.compaction ?? this.threadOptions.compaction ?? this.codexOptions.compaction,
      threadId: this.id,
      workingDirectory: this.workingDirectory
    });
  }
}

/**
 * 处理 upsert item 相关逻辑。
 *
 * @param {unknown} items - items 参数。
 * @param {unknown} item - item 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function upsertItem(items, item) {
  const index = items.findIndex((candidate) => candidate.id === item.id);

  if (index === -1) {
    items.push(item);
    return;
  }

  items[index] = item;
}
