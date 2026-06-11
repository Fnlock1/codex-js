/**
 * 中文模块说明：src/app-server/config.js
 *
 * 面向 UI 或守护进程的 JSONL/RPC app-server 协议层。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_CODEX_JS_CONFIG,
  CONFIG_SCHEMA_VERSION,
  loadCodexJsConfig,
  normalizeCodexJsConfig
} from "../config.js";
import {
  APP_SERVER_ERROR_CODES
} from "./protocol.js";

export const APP_SERVER_CONFIG_LAYER_SOURCES = Object.freeze({
  DEFAULT: "default",
  FILE: "file",
  OVERRIDE: "override"
});

export const CONFIG_MERGE_STRATEGIES = Object.freeze({
  REPLACE: "replace",
  UPSERT: "upsert"
});

export const CONFIG_WRITE_STATUSES = Object.freeze({
  OK: "ok",
  OK_OVERRIDDEN: "okOverridden"
});

export const CONFIG_WRITE_ERROR_CODES = Object.freeze({
  CONFIG_LAYER_READONLY: "configLayerReadonly",
  CONFIG_VALIDATION_ERROR: "configValidationError",
  CONFIG_VERSION_CONFLICT: "configVersionConflict",
  USER_LAYER_NOT_FOUND: "userLayerNotFound"
});

/**
 * 读取 read app server config 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function readAppServerConfig(options = {}) {
  const configPath = options.configPath ?? options.config_path ?? null;
  const cwd = options.cwd == null ? null : resolve(String(options.cwd));
  const includeLayers = Boolean(options.includeLayers ?? options.include_layers ?? false);
  const layers = [
    createConfigLayer({
      name: APP_SERVER_CONFIG_LAYER_SOURCES.DEFAULT,
      version: String(CONFIG_SCHEMA_VERSION),
      config: DEFAULT_CODEX_JS_CONFIG
    })
  ];
  let config = normalizeCodexJsConfig(DEFAULT_CODEX_JS_CONFIG);

  if (configPath) {
    const resolvedPath = resolve(String(configPath));
    const loaded = await loadCodexJsConfig(resolvedPath);
    const version = createConfigVersion(loaded);

    config = normalizeCodexJsConfig({
      ...config,
      ...loaded
    });
    layers.push(createConfigLayer({
      name: APP_SERVER_CONFIG_LAYER_SOURCES.FILE,
      version,
      config: loaded,
      path: resolvedPath
    }));
  }

  if (options.overrides && typeof options.overrides === "object") {
    config = normalizeCodexJsConfig({
      ...config,
      ...options.overrides
    });
    layers.push(createConfigLayer({
      name: APP_SERVER_CONFIG_LAYER_SOURCES.OVERRIDE,
      version: String(CONFIG_SCHEMA_VERSION),
      config: options.overrides
    }));
  }

  if (options.runtimeFeatureEnablement && typeof options.runtimeFeatureEnablement === "object") {
    config = normalizeCodexJsConfig({
      ...config,
      features: {
        ...config.features,
        ...options.runtimeFeatureEnablement
      }
    });
  }

  if (cwd && config.workingDirectory == null) {
    config = normalizeCodexJsConfig({
      ...config,
      workingDirectory: cwd
    });
  }

  return {
    config: configToAppServerConfig(config),
    origins: createConfigOrigins(layers),
    layers: includeLayers ? layers : null
  };
}

/**
 * 读取 read app server config requirements 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function readAppServerConfigRequirements(options = {}) {
  if (!options.requirements) {
    return {
      requirements: null
    };
  }

  return {
    requirements: normalizeConfigRequirements(options.requirements)
  };
}

/**
 * 写入 write app server config value 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} params - params 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function writeAppServerConfigValue(params = {}, options = {}) {
  return await writeAppServerConfigEdits({
    edits: [
      {
        keyPath: requireConfigParam(params, "keyPath"),
        value: Object.hasOwn(params, "value") ? params.value : null,
        mergeStrategy: params.mergeStrategy ?? CONFIG_MERGE_STRATEGIES.REPLACE
      }
    ],
    filePath: params.filePath ?? params.file_path,
    expectedVersion: params.expectedVersion ?? params.expected_version
  }, options);
}

/**
 * 处理 batch write app server config 相关逻辑。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} params - params 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function batchWriteAppServerConfig(params = {}, options = {}) {
  const edits = params.edits;

  if (!Array.isArray(edits) || edits.length === 0) {
    throw createConfigWriteError(
      CONFIG_WRITE_ERROR_CODES.CONFIG_VALIDATION_ERROR,
      "config/batchWrite requires at least one edit",
      {
        reason: "config_edits_required"
      }
    );
  }

  return await writeAppServerConfigEdits({
    edits,
    filePath: params.filePath ?? params.file_path,
    expectedVersion: params.expectedVersion ?? params.expected_version,
    reloadUserConfig: Boolean(params.reloadUserConfig ?? params.reload_user_config ?? false)
  }, options);
}

/**
 * 写入 write app server config edits 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} request - request 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function writeAppServerConfigEdits(request = {}, options = {}) {
  if (!options.allowConfigWrites) {
    throw createConfigWriteError(
      CONFIG_WRITE_ERROR_CODES.CONFIG_LAYER_READONLY,
      "config writes are disabled",
      {
        reason: "config_write_disabled"
      }
    );
  }

  const resolvedPath = resolveConfigWritePath(request, options);
  const current = await loadConfigForWrite(resolvedPath);
  const currentVersion = createConfigVersion(current);
  const expectedVersion = request.expectedVersion == null ? null : String(request.expectedVersion);

  if (expectedVersion && expectedVersion !== currentVersion) {
    throw createConfigWriteError(
      CONFIG_WRITE_ERROR_CODES.CONFIG_VERSION_CONFLICT,
      "Configuration was modified since last read. Fetch latest version and retry.",
      {
        reason: "config_version_conflict",
        expectedVersion,
        actualVersion: currentVersion
      }
    );
  }

  const next = cloneJson(current);

  for (const edit of request.edits ?? []) {
    applyConfigValueWrite(next, edit);
  }

  const normalized = normalizeCodexJsConfig(next);
  await mkdir(dirname(resolvedPath), {
    recursive: true
  });
  await writeFile(resolvedPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");

  return {
    status: CONFIG_WRITE_STATUSES.OK,
    version: createConfigVersion(normalized),
    filePath: resolvedPath,
    overriddenMetadata: null,
    reloadUserConfig: Boolean(request.reloadUserConfig ?? false)
  };
}

/**
 * 应用 apply config value write 相关数据。
 *
 * @param {unknown} config - config 参数。
 * @param {unknown} edit - edit 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function applyConfigValueWrite(config, edit = {}) {
  const keyPath = requireConfigParam(edit, "keyPath");
  const segments = parseConfigKeyPath(keyPath);
  const mergeStrategy = normalizeMergeStrategy(edit.mergeStrategy ?? edit.merge_strategy);
  const value = Object.hasOwn(edit, "value") ? edit.value : null;

  if (segments[0] === "profile" || segments[0] === "profiles") {
    throw createConfigWriteError(
      CONFIG_WRITE_ERROR_CODES.CONFIG_VALIDATION_ERROR,
      "`profile` and `profiles` config paths are not writable in codex-js",
      {
        reason: "config_path_forbidden",
        keyPath
      }
    );
  }

  if (value === null) {
    clearConfigPath(config, segments);
    return config;
  }

  setConfigPath(config, segments, cloneJson(value), mergeStrategy);
  return config;
}

/**
 * 解析 parse config key path 相关数据。
 *
 * @param {unknown} keyPath - keyPath 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function parseConfigKeyPath(keyPath) {
  const text = String(keyPath ?? "");

  if (!text.trim()) {
    throw createConfigWriteError(
      CONFIG_WRITE_ERROR_CODES.CONFIG_VALIDATION_ERROR,
      "keyPath must not be empty",
      {
        reason: "config_key_path_empty"
      }
    );
  }

  const segments = [];
  let segment = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === "\"" && segment === "" && !quoted) {
      quoted = true;
      continue;
    }

    if (char === "\"" && quoted) {
      quoted = false;
      continue;
    }

    if (char === "\\" && quoted) {
      index += 1;

      if (index >= text.length) {
        throw createConfigWriteError(
          CONFIG_WRITE_ERROR_CODES.CONFIG_VALIDATION_ERROR,
          "unterminated escape in keyPath",
          {
            reason: "config_key_path_invalid"
          }
        );
      }

      segment += text[index];
      continue;
    }

    if (char === "." && !quoted) {
      if (!segment) {
        throw createConfigWriteError(
          CONFIG_WRITE_ERROR_CODES.CONFIG_VALIDATION_ERROR,
          "keyPath segments must not be empty",
          {
            reason: "config_key_path_invalid"
          }
        );
      }

      segments.push(segment);
      segment = "";
      continue;
    }

    if (char === "\"") {
      throw createConfigWriteError(
        CONFIG_WRITE_ERROR_CODES.CONFIG_VALIDATION_ERROR,
        "invalid quoted keyPath segment",
        {
          reason: "config_key_path_invalid"
        }
      );
    }

    segment += char;
  }

  if (quoted) {
    throw createConfigWriteError(
      CONFIG_WRITE_ERROR_CODES.CONFIG_VALIDATION_ERROR,
      "unterminated quoted keyPath segment",
      {
        reason: "config_key_path_invalid"
      }
    );
  }

  if (!segment) {
    throw createConfigWriteError(
      CONFIG_WRITE_ERROR_CODES.CONFIG_VALIDATION_ERROR,
      "keyPath segments must not be empty",
      {
        reason: "config_key_path_invalid"
      }
    );
  }

  segments.push(segment);
  return segments;
}

/**
 * 创建 create config version 相关数据。
 *
 * @param {unknown} config - config 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createConfigVersion(config = {}) {
  return `sha256:${createHash("sha256")
    .update(stableJsonStringify(normalizeCodexJsConfig(config)))
    .digest("hex")}`;
}

/**
 * 处理 config to app server config 相关逻辑。
 *
 * @param {unknown} config - config 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function configToAppServerConfig(config = {}) {
  const normalized = normalizeCodexJsConfig(config);

  return {
    model: null,
    review_model: null,
    model_context_window: null,
    model_auto_compact_token_limit: null,
    model_auto_compact_token_limit_scope: null,
    model_provider: normalized.model.provider,
    approval_policy: normalized.approval.defaultDecision,
    approvals_reviewer: null,
    sandbox_mode: normalized.sandbox.mode,
    sandbox_workspace_write: normalized.sandbox.mode === "workspace-write"
      ? {
          writableRoots: normalized.workingDirectory ? [normalized.workingDirectory] : [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        }
      : null,
    forced_chatgpt_workspace_id: null,
    forced_login_method: null,
    web_search: null,
    tools: {
      webSearch: false,
      viewImage: true
    },
    instructions: null,
    developer_instructions: null,
    compact_prompt: null,
    model_reasoning_effort: null,
    model_reasoning_summary: null,
    model_verbosity: null,
    service_tier: null,
    analytics: null,
    desktop: normalized.desktop,
    features: {
      ...normalized.features
    },
    codex_js: normalized
  };
}

/**
 * 创建 create config layer 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createConfigLayer(options = {}) {
  return {
    name: String(options.name ?? APP_SERVER_CONFIG_LAYER_SOURCES.DEFAULT),
    version: String(options.version ?? CONFIG_SCHEMA_VERSION),
    config: options.config ?? {},
    disabledReason: options.disabledReason ?? options.disabled_reason ?? null,
    ...(options.path ? { path: String(options.path) } : {})
  };
}

/**
 * 创建 create config origins 相关数据。
 *
 * @param {unknown} layers - layers 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createConfigOrigins(layers = []) {
  const origins = {};

  for (const layer of layers) {
    for (const key of Object.keys(layer.config ?? {})) {
      origins[key] = {
        name: layer.name,
        version: layer.version
      };
    }
  }

  return origins;
}

/**
 * 归一化 normalize config requirements 相关数据。
 *
 * @param {unknown} requirements - requirements 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeConfigRequirements(requirements = {}) {
  return {
    allowedApprovalPolicies: normalizeNullableArray(requirements.allowedApprovalPolicies ?? requirements.allowed_approval_policies),
    allowedSandboxModes: normalizeNullableArray(requirements.allowedSandboxModes ?? requirements.allowed_sandbox_modes),
    allowedWindowsSandboxImplementations: normalizeNullableArray(
      requirements.allowedWindowsSandboxImplementations ??
      requirements.allowed_windows_sandbox_implementations
    ),
    allowedPermissions: normalizeNullableArray(requirements.allowedPermissions ?? requirements.allowed_permissions),
    allowedWebSearchModes: normalizeNullableArray(requirements.allowedWebSearchModes ?? requirements.allowed_web_search_modes),
    allowManagedHooksOnly: normalizeNullableBoolean(requirements.allowManagedHooksOnly ?? requirements.allow_managed_hooks_only),
    allowAppshots: normalizeNullableBoolean(requirements.allowAppshots ?? requirements.allow_appshots),
    computerUse: requirements.computerUse ?? requirements.computer_use ?? null,
    featureRequirements: requirements.featureRequirements ?? requirements.feature_requirements ?? null,
    enforceResidency: requirements.enforceResidency ?? requirements.enforce_residency ?? null,
    hooks: requirements.hooks ?? null,
    network: requirements.network ?? null
  };
}

/**
 * 处理 config file exists 相关逻辑。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} configPath - configPath 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export async function configFileExists(configPath) {
  if (!configPath) {
    return false;
  }

  try {
    const info = await stat(resolve(String(configPath)));
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * 解析 resolve config write path 相关数据。
 *
 * @param {unknown} request - request 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function resolveConfigWritePath(request = {}, options = {}) {
  const optionPath = options.configPath ?? options.config_path ?? null;
  const requestedPath = request.filePath ?? request.file_path ?? optionPath;

  if (!requestedPath) {
    throw createConfigWriteError(
      CONFIG_WRITE_ERROR_CODES.USER_LAYER_NOT_FOUND,
      "configPath or filePath is required for config writes",
      {
        reason: "config_path_required"
      }
    );
  }

  const resolvedRequested = resolve(String(requestedPath));

  if (optionPath && resolve(String(optionPath)) !== resolvedRequested) {
    throw createConfigWriteError(
      CONFIG_WRITE_ERROR_CODES.CONFIG_LAYER_READONLY,
      "Only writes to the configured codex-js config file are allowed",
      {
        reason: "config_path_mismatch",
        configPath: resolve(String(optionPath)),
        filePath: resolvedRequested
      }
    );
  }

  return resolvedRequested;
}

/**
 * 加载 load config for write 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} configPath - configPath 参数。
 * @returns {unknown} 返回处理后的结果。
 */
async function loadConfigForWrite(configPath) {
  try {
    const content = await readFile(configPath, "utf8");
    return normalizeCodexJsConfig(JSON.parse(content));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return normalizeCodexJsConfig(DEFAULT_CODEX_JS_CONFIG);
    }

    if (error instanceof SyntaxError) {
      throw createConfigWriteError(
        CONFIG_WRITE_ERROR_CODES.CONFIG_VALIDATION_ERROR,
        `failed to parse codex-js config JSON: ${error.message}`,
        {
          reason: "config_parse_error"
        }
      );
    }

    throw error;
  }
}

/**
 * 设置 set config path 相关数据。
 *
 * @param {unknown} root - root 参数。
 * @param {unknown} segments - segments 参数。
 * @param {unknown} value - value 参数。
 * @param {unknown} mergeStrategy - mergeStrategy 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function setConfigPath(root, segments, value, mergeStrategy) {
  const last = segments.at(-1);
  let current = root;

  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(current[segment])) {
      current[segment] = {};
    }

    current = current[segment];
  }

  if (
    mergeStrategy === CONFIG_MERGE_STRATEGIES.UPSERT &&
    isPlainObject(current[last]) &&
    isPlainObject(value)
  ) {
    current[last] = deepMerge(current[last], value);
    return;
  }

  current[last] = value;
}

/**
 * 处理 clear config path 相关逻辑。
 *
 * @param {unknown} root - root 参数。
 * @param {unknown} segments - segments 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function clearConfigPath(root, segments) {
  const last = segments.at(-1);
  let current = root;

  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(current[segment])) {
      return false;
    }

    current = current[segment];
  }

  return delete current[last];
}

/**
 * 归一化 normalize merge strategy 相关数据。
 *
 * @param {unknown} strategy - strategy 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeMergeStrategy(strategy) {
  const normalized = String(strategy ?? CONFIG_MERGE_STRATEGIES.REPLACE);

  if (
    normalized !== CONFIG_MERGE_STRATEGIES.REPLACE &&
    normalized !== CONFIG_MERGE_STRATEGIES.UPSERT
  ) {
    throw createConfigWriteError(
      CONFIG_WRITE_ERROR_CODES.CONFIG_VALIDATION_ERROR,
      `unsupported mergeStrategy: ${normalized}`,
      {
        reason: "config_merge_strategy_invalid",
        mergeStrategy: normalized
      }
    );
  }

  return normalized;
}

/**
 * 处理 require config param 相关逻辑。
 *
 * @param {unknown} params - params 参数。
 * @param {unknown} name - name 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function requireConfigParam(params, name) {
  const value = params?.[name] ?? params?.[toSnakeCase(name)];

  if (value == null || value === "") {
    throw createConfigWriteError(
      CONFIG_WRITE_ERROR_CODES.CONFIG_VALIDATION_ERROR,
      `Missing required param: ${name}`,
      {
        reason: "config_param_required",
        param: name
      }
    );
  }

  return value;
}

/**
 * 创建 create config write error 相关数据。
 *
 * @param {unknown} configWriteErrorCode - configWriteErrorCode 参数。
 * @param {unknown} message - message 参数。
 * @param {unknown} data - data 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function createConfigWriteError(configWriteErrorCode, message, data = {}) {
  const error = new Error(String(message ?? ""));
  error.code = APP_SERVER_ERROR_CODES.INVALID_PARAMS;
  error.data = {
    config_write_error_code: configWriteErrorCode,
    ...data
  };
  return error;
}

/**
 * 处理 deep merge 相关逻辑。
 *
 * @param {unknown} left - left 参数。
 * @param {unknown} right - right 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function deepMerge(left, right) {
  const merged = {
    ...left
  };

  for (const [key, value] of Object.entries(right)) {
    merged[key] = isPlainObject(merged[key]) && isPlainObject(value)
      ? deepMerge(merged[key], value)
      : cloneJson(value);
  }

  return merged;
}

/**
 * 处理 stable json stringify 相关逻辑。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function stableJsonStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }

  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

/**
 * 克隆 clone json 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

/**
 * 判断是否为 is plain object 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * 处理 to snake case 相关逻辑。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function toSnakeCase(value) {
  return String(value).replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

/**
 * 归一化 normalize nullable array 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeNullableArray(value) {
  if (value == null) {
    return null;
  }

  return Array.isArray(value) ? value.map((entry) => String(entry)) : null;
}

/**
 * 归一化 normalize nullable boolean 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeNullableBoolean(value) {
  return value == null ? null : Boolean(value);
}
