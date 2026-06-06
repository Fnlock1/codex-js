import { pathToFileURL } from "node:url";
import {
  ModelClient,
  ModelClientSession,
  createModelResponseItem
} from "../core/model-client.js";

export class PluginModelClient extends ModelClient {
  constructor(options = {}) {
    super();
    this.adapter = options.adapter;
    this.adapterPath = options.adapterPath ?? options.adapter_path ?? null;
    this.adapterOptions = options.adapterOptions ?? options.options ?? {};
    this.sessions = [];
  }

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

export class PluginModelClientSession extends ModelClientSession {
  constructor(options = {}) {
    super();
    this.adapter = options.adapter;
    this.adapterPath = options.adapterPath ?? null;
    this.adapterOptions = options.adapterOptions ?? {};
    this.sessionOptions = options.sessionOptions ?? {};
    this.prompts = [];
  }

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

export async function* normalizeAdapterResponse(response) {
  if (isAsyncIterable(response) || isIterable(response)) {
    for await (const item of response) {
      yield* normalizeAdapterResponseItem(item);
    }
    return;
  }

  yield* normalizeAdapterResponseItem(response);
}

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

function isAsyncIterable(value) {
  return Boolean(value && typeof value[Symbol.asyncIterator] === "function");
}

function isIterable(value) {
  return Boolean(value && typeof value !== "string" && typeof value[Symbol.iterator] === "function");
}
