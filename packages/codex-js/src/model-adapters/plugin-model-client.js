/**
 * 中文模块说明：src/model-adapters/plugin-model-client.js
 *
 * 模型适配器，把不同模型供应商响应统一成运行时事件。
 */
import { pathToFileURL } from "node:url";
import {
  ModelClient,
  ModelClientSession,
  createModelResponseItem
} from "../core/model-client.js";

/**
 * 定义 PluginModelClient 类，封装当前模块的状态和行为。
 */
export class PluginModelClient extends ModelClient {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    super();
    this.adapter = options.adapter;
    this.adapterPath = options.adapterPath ?? options.adapter_path ?? null;
    this.adapterOptions = options.adapterOptions ?? options.options ?? {};
    this.sessions = [];
  }

  /**
   * 处理 from module 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} modulePath - modulePath 参数。
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  static async fromModule(modulePath, options = {}) {
    const resolvedUrl = pathToFileURL(modulePath).href;
    const imported = await import(resolvedUrl);
    const adapterOptions = options.adapterOptions ?? options.options ?? {};

    if (typeof imported.createModelClient === "function") {
      return await imported.createModelClient(adapterOptions);
    }

    const adapter = typeof imported.createModelAdapter === "function"
      ? await imported.createModelAdapter(adapterOptions)
      : imported.default ?? imported;

    return new PluginModelClient({
      adapter,
      adapterPath: modulePath,
      adapterOptions
    });
  }

  /**
   * 创建 create session 相关数据。
   *
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  createSession(options = {}) {
    const session = new PluginModelClientSession({
      adapter: this.adapter,
      adapterPath: this.adapterPath,
      adapterOptions: this.adapterOptions,
      sessionOptions: options
    });

    this.sessions.push(session);
    this.lastSession = session;
    return session;
  }
}

/**
 * 定义 PluginModelClientSession 类，封装当前模块的状态和行为。
 */
export class PluginModelClientSession extends ModelClientSession {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    super();
    this.adapter = options.adapter;
    this.adapterPath = options.adapterPath ?? null;
    this.adapterOptions = options.adapterOptions ?? {};
    this.sessionOptions = options.sessionOptions ?? {};
    this.prompts = [];
  }

  /**
   * 处理 stream response 相关逻辑。
   *
   * 这是异步生成器，会按需产出事件或结果。
   *
   * @param {unknown} prompt - prompt 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async *streamResponse(prompt) {
    this.prompts.push(prompt);

    if (!this.adapter) {
      throw new Error("Plugin model adapter is missing.");
    }

    const response = await callPluginAdapter(this.adapter, prompt, {
      adapterOptions: this.adapterOptions,
      sessionOptions: this.sessionOptions
    });

    yield* normalizeAdapterResponse(response);
  }
}

/**
 * 创建 create plugin model client 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function createPluginModelClient(options = {}) {
  if (options.adapter) {
    return new PluginModelClient(options);
  }

  const modulePath = options.modulePath ?? options.module_path ?? options.path;

  if (!modulePath) {
    throw new Error("Missing model adapter module path.");
  }

  return await PluginModelClient.fromModule(modulePath, options);
}

/**
 * 处理 call plugin adapter 相关逻辑。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} adapter - adapter 参数。
 * @param {unknown} prompt - prompt 参数。
 * @param {unknown} context - context 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function callPluginAdapter(adapter, prompt, context = {}) {
  if (typeof adapter.streamResponse === "function") {
    return adapter.streamResponse(prompt, context);
  }

  if (typeof adapter.generateResponse === "function") {
    return adapter.generateResponse(prompt, context);
  }

  if (typeof adapter.generate === "function") {
    return adapter.generate(prompt, context);
  }

  if (typeof adapter === "function") {
    return adapter(prompt, context);
  }

  throw new Error("Model adapter must export a function, generate(), generateResponse(), or streamResponse().");
}

/**
 * 归一化 normalize adapter response 相关数据。
 *
 * 这是异步生成器，会按需产出事件或结果。
 *
 * @param {unknown} response - response 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function* normalizeAdapterResponse(response) {
  if (isAsyncIterable(response) || isIterable(response)) {
    for await (const item of response) {
      yield* normalizeAdapterResponseItem(item);
    }
    return;
  }

  yield* normalizeAdapterResponseItem(response);
}

/**
 * 归一化 normalize adapter response item 相关数据。
 *
 * 这是异步生成器，会按需产出事件或结果。
 *
 * @param {unknown} item - item 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function* normalizeAdapterResponseItem(item) {
  if (item == null) {
    return;
  }

  if (typeof item === "string") {
    yield createModelResponseItem({
      text: item
    });
    return;
  }

  if (Array.isArray(item)) {
    for (const entry of item) {
      yield* normalizeAdapterResponseItem(entry);
    }
    return;
  }

  if (typeof item === "object") {
    if (Array.isArray(item.items)) {
      yield* normalizeAdapterResponseItem(item.items);
      return;
    }

    if (typeof item.text === "string" && !item.type) {
      yield createModelResponseItem({
        text: item.text,
        raw: item.raw ?? item
      });
      return;
    }

    yield createModelResponseItem(item);
    return;
  }

  yield createModelResponseItem({
    text: String(item)
  });
}

/**
 * 判断是否为 is async iterable 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function isAsyncIterable(value) {
  return Boolean(value && typeof value[Symbol.asyncIterator] === "function");
}

/**
 * 判断是否为 is iterable 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function isIterable(value) {
  return Boolean(value && typeof value !== "string" && typeof value[Symbol.iterator] === "function");
}
