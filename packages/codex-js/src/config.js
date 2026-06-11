/**
 * 中文模块说明：src/config.js
 *
 *
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const CONFIG_SCHEMA_VERSION = 1;

export const DEFAULT_CODEX_JS_CONFIG = Object.freeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  workingDirectory: null,
  sessionStoreDirectory: null,
  memoryStoreDirectory: null,
  mockResponse: null,
  model: {
    provider: "mock",
    adapterPath: null,
    url: null,
    headers: {},
    timeoutMs: 60000,
    options: {}
  },
  runtime: {
    realModelEnabled: false,
    realShellEnabled: false,
    realApplyPatchEnabled: false,
    mcpEnabled: false
  },
  features: {},
  approval: {
    defaultDecision: "prompt"
  },
  sandbox: {
    mode: "workspace-write",
    readRoots: null,
    writeRoots: null,
    networkAllowed: false,
    allowedEnvKeys: [],
    blockedEnvKeys: [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GITHUB_TOKEN",
      "NPM_TOKEN"
    ]
  },
  desktop: null,
  appServer: {
    transport: "in-process",
    listen: null
  },
  tools: {
    hosted: {
      enabled: false,
      headers: {},
      webSearchUrl: null,
      imageGenerationUrl: null
    },
    mcp: {
      enabled: false,
      allowStdioSpawn: false,
      servers: []
    }
  }
});

/**
 * 创建 create default config 相关数据。
 *
 * @param {unknown} overrides - overrides 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createDefaultConfig(overrides = {}) {
  return normalizeCodexJsConfig(overrides);
}

/**
 * 归一化 normalize codex js config 相关数据。
 *
 * @param {unknown} config - config 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeCodexJsConfig(config = {}) {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    workingDirectory: normalizeOptionalPath(config.workingDirectory),
    sessionStoreDirectory: normalizeOptionalPath(config.sessionStoreDirectory),
    memoryStoreDirectory: normalizeOptionalPath(config.memoryStoreDirectory ?? config.memory_store_directory),
    mockResponse: config.mockResponse == null ? null : String(config.mockResponse),
    model: normalizeModelConfig(config.model),
    runtime: {
      ...DEFAULT_CODEX_JS_CONFIG.runtime,
      ...(config.runtime ?? {})
    },
    features: config.features && typeof config.features === "object" && !Array.isArray(config.features)
      ? Object.fromEntries(
          Object.entries(config.features).map(([key, value]) => [key, Boolean(value)])
        )
      : {},
    approval: {
      ...DEFAULT_CODEX_JS_CONFIG.approval,
      ...(config.approval ?? {})
    },
    sandbox: {
      ...DEFAULT_CODEX_JS_CONFIG.sandbox,
      ...(config.sandbox ?? {})
    },
    desktop: config.desktop && typeof config.desktop === "object" && !Array.isArray(config.desktop)
      ? { ...config.desktop }
      : null,
    appServer: {
      ...DEFAULT_CODEX_JS_CONFIG.appServer,
      ...(config.appServer ?? {})
    },
    tools: normalizeToolsConfig(config.tools)
  };
}

/**
 * 加载 load codex js config 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} filePath - filePath 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function loadCodexJsConfig(filePath) {
  if (!filePath) {
    return createDefaultConfig();
  }

  const content = await readFile(filePath, "utf8");
  return normalizeCodexJsConfig(JSON.parse(content));
}

/**
 * 应用 apply cli config overrides 相关数据。
 *
 * @param {unknown} config - config 参数。
 * @param {unknown} parsed - parsed 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function applyCliConfigOverrides(config, parsed = {}) {
  return normalizeCodexJsConfig({
    ...config,
    workingDirectory: parsed.workingDirectory ?? config.workingDirectory,
    sessionStoreDirectory: parsed.sessionStoreDirectory ?? config.sessionStoreDirectory,
    memoryStoreDirectory: parsed.memoryStoreDirectory ?? config.memoryStoreDirectory,
    mockResponse: parsed.mockResponse ?? config.mockResponse,
    model: mergeModelCliOverrides(config.model, parsed),
    tools: mergeToolsCliOverrides(config.tools, parsed)
  });
}

/**
 * 处理 config to codex options 相关逻辑。
 *
 * @param {unknown} config - config 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function configToCodexOptions(config = {}) {
  const normalized = normalizeCodexJsConfig(config);

  return {
    workingDirectory: normalized.workingDirectory ?? undefined,
    sessionStoreDirectory: normalized.sessionStoreDirectory ?? undefined,
    memoryStoreDirectory: normalized.memoryStoreDirectory ?? undefined,
    mockResponse: normalized.mockResponse ?? undefined
  };
}

/**
 * 脱敏 redact codex js config 相关数据。
 *
 * @param {unknown} config - config 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function redactCodexJsConfig(config = {}) {
  const normalized = normalizeCodexJsConfig(config);

  return redactSecrets(normalized);
}

/**
 * 归一化 normalize optional path 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeOptionalPath(value) {
  if (value == null || value === "") {
    return null;
  }

  return resolve(String(value));
}

/**
 * 归一化 normalize model config 相关数据。
 *
 * @param {unknown} model - model 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeModelConfig(model = {}) {
  const adapterPath = normalizeOptionalPath(
    model.adapterPath ?? model.adapter_path ?? model.path
  );
  const url = model.url == null || model.url === "" ? null : String(model.url);
  const inferredProvider = adapterPath
    ? "plugin"
    : url
      ? "http"
      : DEFAULT_CODEX_JS_CONFIG.model.provider;
  const provider = String(model.provider ?? inferredProvider);

  return {
    provider,
    adapterPath,
    url,
    headers: normalizeStringRecord(model.headers),
    timeoutMs: normalizePositiveInteger(
      model.timeoutMs ?? model.timeout_ms,
      DEFAULT_CODEX_JS_CONFIG.model.timeoutMs
    ),
    options: model.options && typeof model.options === "object" && !Array.isArray(model.options)
      ? { ...model.options }
      : {}
  };
}

/**
 * 归一化 normalize tools config 相关数据。
 *
 * @param {unknown} tools - tools 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeToolsConfig(tools = {}) {
  return {
    hosted: {
      ...DEFAULT_CODEX_JS_CONFIG.tools.hosted,
      ...(tools.hosted ?? {}),
      headers: normalizeStringRecord(tools.hosted?.headers),
      webSearchUrl: normalizeOptionalString(tools.hosted?.webSearchUrl ?? tools.hosted?.web_search_url),
      imageGenerationUrl: normalizeOptionalString(
        tools.hosted?.imageGenerationUrl ?? tools.hosted?.image_generation_url
      ),
      enabled: Boolean(tools.hosted?.enabled ?? DEFAULT_CODEX_JS_CONFIG.tools.hosted.enabled)
    },
    mcp: {
      ...DEFAULT_CODEX_JS_CONFIG.tools.mcp,
      ...(tools.mcp ?? {}),
      enabled: Boolean(tools.mcp?.enabled ?? DEFAULT_CODEX_JS_CONFIG.tools.mcp.enabled),
      allowStdioSpawn: Boolean(
        tools.mcp?.allowStdioSpawn ??
        tools.mcp?.allow_stdio_spawn ??
        DEFAULT_CODEX_JS_CONFIG.tools.mcp.allowStdioSpawn
      ),
      servers: normalizeMcpServerConfigs(tools.mcp?.servers)
    }
  };
}

/**
 * 处理 merge tools cli overrides 相关逻辑。
 *
 * @param {unknown} tools - tools 参数。
 * @param {unknown} parsed - parsed 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function mergeToolsCliOverrides(tools = {}, parsed = {}) {
  const normalized = normalizeToolsConfig(tools);
  const next = {
    hosted: {
      ...normalized.hosted,
      headers: {
        ...normalized.hosted.headers
      }
    },
    mcp: {
      ...normalized.mcp,
      servers: [...normalized.mcp.servers]
    }
  };

  if (parsed.enableHostedTools) {
    next.hosted.enabled = true;
  }

  if (parsed.webSearchUrl) {
    next.hosted.enabled = true;
    next.hosted.webSearchUrl = parsed.webSearchUrl;
  }

  if (parsed.imageGenerationUrl) {
    next.hosted.enabled = true;
    next.hosted.imageGenerationUrl = parsed.imageGenerationUrl;
  }

  if (parsed.hostedToolHeaders && typeof parsed.hostedToolHeaders === "object") {
    next.hosted.headers = {
      ...next.hosted.headers,
      ...normalizeStringRecord(parsed.hostedToolHeaders)
    };
  }

  if (parsed.allowMcp) {
    next.mcp.enabled = true;
    next.mcp.allowStdioSpawn = true;
  }

  if (parsed.mcpServers?.length > 0) {
    next.mcp.enabled = true;
    next.mcp.servers.push(...normalizeMcpServerConfigs(parsed.mcpServers));
  }

  return next;
}

/**
 * 处理 merge model cli overrides 相关逻辑。
 *
 * @param {unknown} model - model 参数。
 * @param {unknown} parsed - parsed 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function mergeModelCliOverrides(model = {}, parsed = {}) {
  const normalized = normalizeModelConfig(model);
  const next = {
    ...normalized,
    headers: { ...normalized.headers },
    options: { ...normalized.options }
  };

  if (parsed.modelAdapterPath) {
    next.provider = "plugin";
    next.adapterPath = parsed.modelAdapterPath;
  }

  if (parsed.modelUrl) {
    next.provider = "http";
    next.url = parsed.modelUrl;
  }

  if (parsed.modelProvider) {
    next.provider = parsed.modelProvider;
  }

  if (parsed.modelName) {
    next.options.model = parsed.modelName;
  }

  if (parsed.modelBaseUrl) {
    next.options.baseUrl = parsed.modelBaseUrl;
  }

  if (parsed.modelApiKey) {
    next.options.apiKey = parsed.modelApiKey;
  }

  if (parsed.modelHeaders && typeof parsed.modelHeaders === "object") {
    next.headers = {
      ...next.headers,
      ...normalizeStringRecord(parsed.modelHeaders)
    };
  }

  if (parsed.modelOptions && typeof parsed.modelOptions === "object") {
    next.options = {
      ...next.options,
      ...parsed.modelOptions
    };
  }

  if (parsed.modelTimeoutMs != null) {
    next.timeoutMs = parsed.modelTimeoutMs;
  }

  return next;
}

/**
 * 归一化 normalize string record 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeStringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entry]) => key)
      .map(([key, entry]) => [String(key), String(entry)])
  );
}

/**
 * 归一化 normalize optional string 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeOptionalString(value) {
  if (value == null || value === "") {
    return null;
  }

  return String(value);
}

/**
 * 归一化 normalize mcp server configs 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeMcpServerConfigs(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      if (typeof entry === "string") {
        return parseMcpServerConfigString(entry);
      }

      if (!entry || typeof entry !== "object") {
        return null;
      }

      return {
        ...entry,
        name: entry.name == null ? undefined : String(entry.name),
        info: entry.info && typeof entry.info === "object" ? { ...entry.info } : undefined,
        config: entry.config && typeof entry.config === "object"
          ? { ...entry.config }
          : undefined
      };
    })
    .filter(Boolean);
}

/**
 * 解析 parse mcp server config string 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function parseMcpServerConfigString(value) {
  const text = String(value ?? "");
  const [namePart, commandPart = ""] = text.split("=", 2);
  const name = namePart.trim();
  const commandText = commandPart.trim();

  if (!name || !commandText) {
    return null;
  }

  const parts = commandText.split(/\s+/u).filter(Boolean);

  return {
    info: {
      name
    },
    config: {
      transport: "stdio",
      command: parts[0],
      args: parts.slice(1)
    }
  };
}

/**
 * 归一化 normalize positive integer 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @param {unknown} fallback - fallback 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizePositiveInteger(value, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }

  return Math.trunc(number);
}

/**
 * 脱敏 redact secrets 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @param {unknown} path - path 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function redactSecrets(value, path = []) {
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactSecrets(entry, path.concat(String(index))));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (isSecretKey(key, path)) {
        return [key, entry == null || entry === "" ? entry : "[redacted]"];
      }

      return [key, redactSecrets(entry, path.concat(key))];
    })
  );
}

/**
 * 判断是否为 is secret key 相关数据。
 *
 * @param {unknown} key - key 参数。
 * @param {unknown} path - path 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function isSecretKey(key, path) {
  const normalized = String(key ?? "").toLowerCase();
  const joinedPath = path.concat(normalized).join(".");

  if (joinedPath === "model.headers.authorization") {
    return true;
  }

  return /(^|_)(api_?key|token|secret|password)$/u.test(normalized) ||
    normalized === "authorization" ||
    normalized === "bearer";
}
