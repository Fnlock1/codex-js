import {
  APP_SERVER_ERROR_CODES,
  createAppServerProtocolError
} from "./protocol.js";

export const EXPERIMENTAL_FEATURE_STAGES = Object.freeze({
  BETA: "beta",
  UNDER_DEVELOPMENT: "underDevelopment",
  STABLE: "stable",
  DEPRECATED: "deprecated",
  REMOVED: "removed"
});

export const SUPPORTED_EXPERIMENTAL_FEATURE_ENABLEMENT = Object.freeze([
  "auth_elicitation",
  "memories",
  "mentions_v2",
  "remote_control",
  "remote_plugin",
  "tool_suggest"
]);

export const EXPERIMENTAL_FEATURES = Object.freeze([
  feature("undo", EXPERIMENTAL_FEATURE_STAGES.REMOVED, false),
  feature("shell_tool", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("unified_exec", EXPERIMENTAL_FEATURE_STAGES.STABLE, process.platform !== "win32"),
  feature("shell_zsh_fork", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("unified_exec_zsh_fork", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  betaFeature("terminal_resize_reflow", true, {
    displayName: "Terminal resize reflow",
    description: "Rebuild Codex-owned transcript scrollback when the terminal width changes."
  }),
  feature("web_search_request", EXPERIMENTAL_FEATURE_STAGES.DEPRECATED, false),
  feature("web_search_cached", EXPERIMENTAL_FEATURE_STAGES.DEPRECATED, false),
  feature("standalone_web_search", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("runtime_metrics", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  betaFeature("memories", false, {
    displayName: "Memories",
    description: "Allow Codex to create new memories from conversations and bring relevant memories into new conversations.",
    announcement: "NEW: Codex can now generate and use memories. Try it now with `/memories`"
  }),
  feature("local_thread_store_compression", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("chronicle", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("child_agents_md", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("apply_patch_streaming_events", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("exec_permission_approvals", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("hooks", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("request_permissions_tool", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("use_legacy_landlock", EXPERIMENTAL_FEATURE_STAGES.DEPRECATED, false),
  feature("enable_request_compression", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  betaFeature("network_proxy", false, {
    displayName: "Network proxy",
    description: "Apply network proxy restrictions to sandboxed sessions that already have network access.",
    announcement: "NEW: Network proxy can now be enabled from /experimental. Restart Codex after enabling it."
  }),
  feature("multi_agent", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("multi_agent_v2", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("enable_fanout", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("apps", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("enable_mcp_apps", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("apps_mcp_path_override", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("tool_search", EXPERIMENTAL_FEATURE_STAGES.REMOVED, false),
  feature("tool_search_always_defer_mcp_tools", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("non_prefixed_mcp_tool_names", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("tool_suggest", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("plugins", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("in_app_browser", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("browser_use", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("browser_use_external", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("computer_use", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("remote_plugin", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("plugin_sharing", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  betaFeature("external_migration", false, {
    displayName: "External migration",
    description: "Show a startup prompt when Codex detects migratable external agent config for this machine or project."
  }),
  feature("image_generation", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("imagegenext", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("skill_mcp_dependency_install", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("mentions_v2", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("default_mode_request_user_input", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("guardian_approval", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("goals", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("tool_call_mcp_elicitation", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("auth_elicitation", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("personality", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("artifact", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("fast_mode", EXPERIMENTAL_FEATURE_STAGES.STABLE, true),
  feature("realtime_conversation", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("remote_control", EXPERIMENTAL_FEATURE_STAGES.REMOVED, false),
  betaFeature("prevent_idle_sleep", false, {
    displayName: "Prevent sleep while running",
    description: "Keep your computer awake while Codex is running a thread.",
    announcement: "NEW: Prevent sleep while running is now available in /experimental."
  }),
  feature("remote_compaction_v2", EXPERIMENTAL_FEATURE_STAGES.UNDER_DEVELOPMENT, false),
  feature("workspace_dependencies", EXPERIMENTAL_FEATURE_STAGES.STABLE, true)
]);

export class ExperimentalFeatureEnablementStore {
  constructor(initialEnablement = {}) {
    this.enablement = {};
    this.patch(initialEnablement);
  }

  patch(enablement = {}) {
    const accepted = {};

    if (!enablement || typeof enablement !== "object" || Array.isArray(enablement)) {
      return accepted;
    }

    for (const [name, enabled] of Object.entries(enablement)) {
      if (!SUPPORTED_EXPERIMENTAL_FEATURE_ENABLEMENT.includes(name)) {
        continue;
      }

      accepted[name] = Boolean(enabled);
      this.enablement[name] = Boolean(enabled);
    }

    return accepted;
  }

  get(name) {
    return this.enablement[name];
  }

  toJSON() {
    return {
      ...this.enablement
    };
  }
}

export function listExperimentalFeatures(params = {}, options = {}) {
  const runtimeEnablement = options.runtimeEnablement ?? {};
  const configFeatures = options.configFeatures ?? {};
  const total = EXPERIMENTAL_FEATURES.length;
  const limit = clampFeatureLimit(params.limit, total);
  const start = decodeFeatureCursor(params.cursor, total);
  const end = Math.min(start + limit, total);
  const data = EXPERIMENTAL_FEATURES.slice(start, end).map((spec) => createExperimentalFeatureView(spec, {
    runtimeEnablement,
    configFeatures
  }));

  return {
    data,
    nextCursor: end < total ? String(end) : null
  };
}

export function setExperimentalFeatureEnablement(params = {}, store = new ExperimentalFeatureEnablementStore()) {
  return {
    enablement: store.patch(params.enablement ?? {})
  };
}

export function createExperimentalFeatureView(spec, options = {}) {
  const configFeatures = options.configFeatures ?? {};
  const runtimeEnablement = options.runtimeEnablement ?? {};
  const enabled = typeof configFeatures[spec.name] === "boolean"
    ? configFeatures[spec.name]
    : typeof runtimeEnablement[spec.name] === "boolean"
      ? runtimeEnablement[spec.name]
      : spec.defaultEnabled;

  return {
    name: spec.name,
    stage: spec.stage,
    displayName: spec.stage === EXPERIMENTAL_FEATURE_STAGES.BETA ? spec.displayName : null,
    description: spec.stage === EXPERIMENTAL_FEATURE_STAGES.BETA ? spec.description : null,
    announcement: spec.stage === EXPERIMENTAL_FEATURE_STAGES.BETA ? spec.announcement : null,
    enabled,
    defaultEnabled: spec.defaultEnabled
  };
}

function feature(name, stage, defaultEnabled) {
  return Object.freeze({
    name,
    stage,
    displayName: null,
    description: null,
    announcement: null,
    defaultEnabled: Boolean(defaultEnabled)
  });
}

function betaFeature(name, defaultEnabled, options = {}) {
  return Object.freeze({
    name,
    stage: EXPERIMENTAL_FEATURE_STAGES.BETA,
    displayName: String(options.displayName ?? name),
    description: String(options.description ?? ""),
    announcement: options.announcement ? String(options.announcement) : null,
    defaultEnabled: Boolean(defaultEnabled)
  });
}

function clampFeatureLimit(limit, total) {
  const number = Number(limit ?? total);

  if (!Number.isFinite(number) || number <= 0) {
    return 1;
  }

  return Math.min(Math.floor(number), total);
}

function decodeFeatureCursor(cursor, total) {
  if (cursor == null || cursor === "") {
    return 0;
  }

  const start = Number.parseInt(String(cursor), 10);

  if (!Number.isSafeInteger(start) || start < 0) {
    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_REQUEST,
      `invalid cursor: ${cursor}`,
      {
        reason: "invalid_cursor",
        cursor: String(cursor)
      }
    );
  }

  if (start > total) {
    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_REQUEST,
      `cursor ${start} exceeds total feature flags ${total}`,
      {
        reason: "cursor_out_of_range",
        cursor: String(cursor),
        total
      }
    );
  }

  return start;
}
