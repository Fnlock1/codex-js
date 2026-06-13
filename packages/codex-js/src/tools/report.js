/**
 * 中文模块说明：src/tools/report.js
 *
 * 工具定义、路由、handler、内置工具和上游工具格式转换。
 */
import {
  BUILTIN_TOOL_CATEGORIES,
  TOOL_EXPOSURE,
  createBuiltinToolDefinitions
} from "./builtins.js";
import { BUILTIN_TOOL_NAMES } from "./runtime.js";

export const TOOL_CAPABILITY_STATUSES = Object.freeze({
  READY: "ready",
  GATED: "gated",
  CONFIG_REQUIRED: "config_required",
  DEFERRED: "deferred",
  HIDDEN: "hidden",
  DYNAMIC: "dynamic"
});

export const UPSTREAM_TOOL_GAPS = Object.freeze([
  {
    area: "hosted_web_search",
    status: "provider_required",
    description: "web_search has an HTTP provider bridge, but no bundled search backend."
  },
  {
    area: "hosted_image_generation",
    status: "provider_required",
    description: "image_generation has an HTTP provider bridge, but no bundled image model backend."
  },
  {
    area: "mcp_ecosystem",
    status: "partial",
    description: "MCP stdio discovery/runtime is wired, but marketplace/install UX and broad server lifecycle handling are not upstream-complete."
  },
  {
    area: "sub_agents",
    status: "partial",
    description: "spawn_agent/wait_agent can run child turns in CLI model mode, but there is no upstream-level scheduler, worker pool, budgeting, or aggregation policy."
  },
  {
    area: "sandbox",
    status: "partial",
    description: "The JS sandbox is policy-level; it is not a full OS-level sandbox equivalent to upstream platform sandboxes."
  },
  {
    area: "approval_ui",
    status: "partial",
    description: "Approval gates exist, but the CLI prompt is simpler than upstream TUI/app review flows."
  },
  {
    area: "tool_streaming",
    status: "partial",
    description: "Exec/session output is represented, but tool streaming and rich UI event rendering are not as complete as upstream."
  }
]);

/**
 * 创建 create tool capability report 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createToolCapabilityReport(options = {}) {
  const runtime = options.runtime ?? null;
  const config = options.config ?? {};
  const entries = runtime?.router?.list
    ? runtime.router.list()
    : createBuiltinToolDefinitions({
        includeHostedTools: Boolean(config.tools?.hosted?.enabled)
      });
  const builtInNames = new Set(Object.values(BUILTIN_TOOL_NAMES));
  const tools = entries
    .map((entry) => createToolCapability(entry, {
      builtInNames,
      config,
      runtime
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const counts = countToolCapabilities(tools);

  return {
    summary: {
      declaredBuiltinTools: builtInNames.size,
      registeredTools: tools.length,
      modelVisibleTools: counts.exposure[TOOL_EXPOSURE.MODEL_VISIBLE] ?? 0,
      deferredTools: counts.exposure[TOOL_EXPOSURE.DEFERRED] ?? 0,
      hiddenTools: counts.exposure[TOOL_EXPOSURE.HIDDEN] ?? 0,
      dynamicTools: tools.filter((tool) => tool.dynamic).length,
      hostedToolsEnabled: Boolean(config.tools?.hosted?.enabled),
      mcpEnabled: Boolean(config.tools?.mcp?.enabled),
      shellEnabled: Boolean(options.allowShell),
      applyPatchWritesEnabled: Boolean(options.allowApplyPatchWrites),
      networkAllowed: Boolean(config.sandbox?.networkAllowed ?? config.sandbox?.network_allowed)
    },
    counts,
    tools,
    gaps: [...UPSTREAM_TOOL_GAPS]
  };
}

/**
 * 创建 create tool doctor findings 相关数据。
 *
 * @param {unknown} report - report 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createToolDoctorFindings(report) {
  const findings = [];
  const byName = new Map(report.tools.map((tool) => [tool.name, tool]));

  if (!report.summary.shellEnabled) {
    findings.push({
      severity: "info",
      area: "exec",
      message: "shell_command/exec are registered, but real shell execution is disabled until --allow-shell is used."
    });
  }

  if (!report.summary.applyPatchWritesEnabled) {
    findings.push({
      severity: "info",
      area: "apply_patch",
      message: "apply_patch can parse/preview, but real writes are disabled until --allow-apply-patch is used."
    });
  }

  if (byName.has(BUILTIN_TOOL_NAMES.WEB_SEARCH) && !byName.get(BUILTIN_TOOL_NAMES.WEB_SEARCH).configured) {
    findings.push({
      severity: "warn",
      area: "web_search",
      message: "web_search is exposed, but no --web-search-url provider is configured."
    });
  }

  if (byName.has(BUILTIN_TOOL_NAMES.IMAGE_GENERATION) && !byName.get(BUILTIN_TOOL_NAMES.IMAGE_GENERATION).configured) {
    findings.push({
      severity: "warn",
      area: "image_generation",
      message: "image_generation is exposed, but no --image-generation-url provider is configured."
    });
  }

  if ((byName.has(BUILTIN_TOOL_NAMES.WEB_SEARCH) || byName.has(BUILTIN_TOOL_NAMES.IMAGE_GENERATION)) && !report.summary.networkAllowed) {
    findings.push({
      severity: "warn",
      area: "network",
      message: "Hosted tools need network access; pass --allow-network when using HTTP providers."
    });
  }

  if (!report.summary.mcpEnabled) {
    findings.push({
      severity: "info",
      area: "mcp",
      message: "MCP tools are registered as deferred resource helpers, but MCP server access is disabled until --allow-mcp or config.tools.mcp.enabled."
    });
  }

  for (const gap of report.gaps) {
    findings.push({
      severity: gap.status === "partial" ? "warn" : "info",
      area: gap.area,
      message: gap.description
    });
  }

  return findings;
}

/**
 * 格式化 format tool report text 相关数据。
 *
 * @param {unknown} report - report 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function formatToolReportText(report, options = {}) {
  const lines = [
    "codex-js tools",
    "",
    `registered: ${report.summary.registeredTools}`,
    `declared built-ins: ${report.summary.declaredBuiltinTools}`,
    `model-visible: ${report.summary.modelVisibleTools}`,
    `deferred: ${report.summary.deferredTools}`,
    `hidden: ${report.summary.hiddenTools}`,
    `dynamic: ${report.summary.dynamicTools}`,
    ""
  ];

  for (const tool of report.tools) {
    lines.push([
      tool.name.padEnd(28),
      tool.status.padEnd(15),
      tool.exposure.padEnd(13),
      tool.category
    ].join("  ").trimEnd());

    if (options.verbose) {
      lines.push(`  ${tool.description || "(no description)"}`);
      if (tool.notes.length > 0) {
        for (const note of tool.notes) {
          lines.push(`  - ${note}`);
        }
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * 格式化 format tool doctor text 相关数据。
 *
 * @param {unknown} report - report 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function formatToolDoctorText(report) {
  const findings = createToolDoctorFindings(report);
  const lines = [
    "codex-js tools doctor",
    "",
    `registered: ${report.summary.registeredTools}`,
    `hosted enabled: ${report.summary.hostedToolsEnabled ? "yes" : "no"}`,
    `mcp enabled: ${report.summary.mcpEnabled ? "yes" : "no"}`,
    `shell enabled: ${report.summary.shellEnabled ? "yes" : "no"}`,
    `apply_patch writes: ${report.summary.applyPatchWritesEnabled ? "yes" : "no"}`,
    `network allowed: ${report.summary.networkAllowed ? "yes" : "no"}`,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const finding of findings) {
      lines.push(`[${finding.severity}] ${finding.area}: ${finding.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * 创建 create tool capability 相关数据。
 *
 * @param {unknown} entry - entry 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function createToolCapability(entry, options = {}) {
  const metadata = entry.metadata ?? {};
  const exposure = metadata.exposure ?? TOOL_EXPOSURE.MODEL_VISIBLE;
  const category = metadata.category ?? BUILTIN_TOOL_CATEGORIES.PLACEHOLDER;
  const name = entry.name ?? entry.spec?.name;
  const dynamic = !options.builtInNames?.has(name);
  const configured = toolIsConfigured(name, options.config);
  const notes = createToolNotes(name, {
    metadata,
    configured,
    config: options.config
  });

  return {
    name,
    type: entry.spec?.type ?? "function",
    description: entry.spec?.description ?? "",
    category,
    exposure,
    status: determineToolStatus({
      name,
      exposure,
      category,
      dynamic,
      configured
    }),
    configured,
    dynamic,
    requiresApproval: Boolean(metadata.requiresApproval),
    requiresSandbox: Boolean(metadata.requiresSandbox),
    handler: entry.handler ? entry.handler.constructor?.name ?? "handler" : null,
    notes
  };
}

/**
 * 处理 determine tool status 相关逻辑。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function determineToolStatus(options = {}) {
  if (options.dynamic) {
    return TOOL_CAPABILITY_STATUSES.DYNAMIC;
  }

  if (options.exposure === TOOL_EXPOSURE.HIDDEN) {
    return TOOL_CAPABILITY_STATUSES.HIDDEN;
  }

  if (options.exposure === TOOL_EXPOSURE.DEFERRED) {
    return TOOL_CAPABILITY_STATUSES.DEFERRED;
  }

  if (
    [BUILTIN_TOOL_NAMES.WEB_SEARCH, BUILTIN_TOOL_NAMES.IMAGE_GENERATION].includes(options.name) &&
    !options.configured
  ) {
    return TOOL_CAPABILITY_STATUSES.CONFIG_REQUIRED;
  }

  if (
    [
      BUILTIN_TOOL_NAMES.SHELL_COMMAND,
      BUILTIN_TOOL_NAMES.EXEC,
      BUILTIN_TOOL_NAMES.EXEC_COMMAND,
      BUILTIN_TOOL_NAMES.WRITE_STDIN,
      BUILTIN_TOOL_NAMES.APPLY_PATCH,
      BUILTIN_TOOL_NAMES.REQUEST_PERMISSIONS
    ].includes(options.name)
  ) {
    return TOOL_CAPABILITY_STATUSES.GATED;
  }

  return TOOL_CAPABILITY_STATUSES.READY;
}

/**
 * 处理 tool is configured 相关逻辑。
 *
 * @param {unknown} name - name 参数。
 * @param {unknown} config - config 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function toolIsConfigured(name, config = {}) {
  if (name === BUILTIN_TOOL_NAMES.WEB_SEARCH) {
    return Boolean(config.tools?.hosted?.webSearchUrl);
  }

  if (name === BUILTIN_TOOL_NAMES.IMAGE_GENERATION) {
    return Boolean(config.tools?.hosted?.imageGenerationUrl);
  }

  if (
    [
      BUILTIN_TOOL_NAMES.LIST_MCP_RESOURCES,
      BUILTIN_TOOL_NAMES.LIST_MCP_RESOURCE_TEMPLATES,
      BUILTIN_TOOL_NAMES.READ_MCP_RESOURCE
    ].includes(name)
  ) {
    return Boolean(config.tools?.mcp?.enabled);
  }

  return true;
}

/**
 * 创建 create tool notes 相关数据。
 *
 * @param {unknown} name - name 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function createToolNotes(name, options = {}) {
  const notes = [];

  if (options.metadata.requiresApproval) {
    notes.push("requires approval gate");
  }

  if (options.metadata.requiresSandbox) {
    notes.push("checks sandbox policy");
  }

  if (name === BUILTIN_TOOL_NAMES.SHELL_COMMAND || name === BUILTIN_TOOL_NAMES.EXEC) {
    notes.push("real execution requires --allow-shell");
  }

  if (name === BUILTIN_TOOL_NAMES.APPLY_PATCH) {
    notes.push("real writes require --allow-apply-patch");
  }

  if (name === BUILTIN_TOOL_NAMES.WEB_SEARCH && !options.configured) {
    notes.push("requires --web-search-url");
  }

  if (name === BUILTIN_TOOL_NAMES.IMAGE_GENERATION && !options.configured) {
    notes.push("requires --image-generation-url");
  }

  if (
    [
      BUILTIN_TOOL_NAMES.LIST_MCP_RESOURCES,
      BUILTIN_TOOL_NAMES.LIST_MCP_RESOURCE_TEMPLATES,
      BUILTIN_TOOL_NAMES.READ_MCP_RESOURCE
    ].includes(name) &&
    !options.config?.tools?.mcp?.enabled
  ) {
    notes.push("requires --allow-mcp or MCP config for real server access");
  }

  return notes;
}

/**
 * 处理 count tool capabilities 相关逻辑。
 *
 * @param {unknown} tools - tools 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function countToolCapabilities(tools) {
  const counts = {
    status: {},
    category: {},
    exposure: {}
  };

  for (const tool of tools) {
    increment(counts.status, tool.status);
    increment(counts.category, tool.category);
    increment(counts.exposure, tool.exposure);
  }

  return counts;
}

/**
 * 处理 increment 相关逻辑。
 *
 * @param {unknown} target - target 参数。
 * @param {unknown} key - key 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function increment(target, key) {
  target[key] = (target[key] ?? 0) + 1;
}
