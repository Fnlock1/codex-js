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

export function createConfigVersion(config = {}) {
  return `sha256:${createHash("sha256")
    .update(stableJsonStringify(normalizeCodexJsConfig(config)))
    .digest("hex")}`;
}

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

export function createConfigLayer(options = {}) {
  return {
    name: String(options.name ?? APP_SERVER_CONFIG_LAYER_SOURCES.DEFAULT),
    version: String(options.version ?? CONFIG_SCHEMA_VERSION),
    config: options.config ?? {},
    disabledReason: options.disabledReason ?? options.disabled_reason ?? null,
    ...(options.path ? { path: String(options.path) } : {})
  };
}

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

function createConfigWriteError(configWriteErrorCode, message, data = {}) {
  const error = new Error(String(message ?? ""));
  error.code = APP_SERVER_ERROR_CODES.INVALID_PARAMS;
  error.data = {
    config_write_error_code: configWriteErrorCode,
    ...data
  };
  return error;
}

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

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toSnakeCase(value) {
  return String(value).replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

function normalizeNullableArray(value) {
  if (value == null) {
    return null;
  }

  return Array.isArray(value) ? value.map((entry) => String(entry)) : null;
}

function normalizeNullableBoolean(value) {
  return value == null ? null : Boolean(value);
}
