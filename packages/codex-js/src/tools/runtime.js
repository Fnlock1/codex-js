/**
 * 中文模块说明：src/tools/runtime.js
 *
 * 工具调用运行时，组合内置工具、审批、sandbox、MCP 和子 agent。
 */
import {
  APPROVAL_ACTIONS,
  APPROVAL_RESOURCE_TYPES
} from "../approval/policy.js";
import { ExecRunner } from "../exec/runner.js";
import { CommandSessionManager } from "../exec/session.js";
import { MemoryStore } from "../memory/store.js";
import {
  createBuiltinToolDefinitions
} from "./builtins.js";
import {
  ApplyPatchToolHandler,
  ExecCommandToolHandler,
  GoalToolHandler,
  HostedProviderToolHandler,
  InMemoryGoalStore,
  MemoryToolHandler,
  McpResourceToolHandler,
  PlaceholderToolHandler,
  PlanExpertsToolHandler,
  RequestPermissionsToolHandler,
  ShellCommandToolHandler,
  SpawnAgentToolHandler,
  ToolSearchToolHandler,
  ViewImageToolHandler,
  WaitAgentToolHandler,
  WriteStdinToolHandler
} from "./handlers.js";
import {
  ListFilesToolHandler,
  ReadFileToolHandler,
  SearchFilesToolHandler
} from "./file-tools.js";
import {
  GitDiffToolHandler,
  GitStatusToolHandler
} from "./git-tools.js";
import { AgentCoordinator } from "../agents/coordinator.js";
import { ToolRegistry } from "./registry.js";
import { ToolRouter } from "./router.js";

export const TOOL_CALL_RESULT_STATUSES = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed"
});

export const BUILTIN_TOOL_NAMES = Object.freeze({
  SHELL_COMMAND: "shell_command",
  EXEC: "exec",
  EXEC_COMMAND: "exec_command",
  WRITE_STDIN: "write_stdin",
  APPLY_PATCH: "apply_patch",
  READ_FILE: "read_file",
  LIST_FILES: "list_files",
  SEARCH_FILES: "search_files",
  GIT_STATUS: "git_status",
  GIT_DIFF: "git_diff",
  REQUEST_PERMISSIONS: "request_permissions",
  VIEW_IMAGE: "view_image",
  WEB_SEARCH: "web_search",
  IMAGE_GENERATION: "image_generation",
  TOOL_SEARCH: "tool_search",
  LIST_MCP_RESOURCES: "list_mcp_resources",
  LIST_MCP_RESOURCE_TEMPLATES: "list_mcp_resource_templates",
  READ_MCP_RESOURCE: "read_mcp_resource",
  PLAN_EXPERTS: "plan_experts",
  SPAWN_AGENT: "spawn_agent",
  WAIT_AGENT: "wait_agent",
  GET_GOAL: "get_goal",
  CREATE_GOAL: "create_goal",
  UPDATE_GOAL: "update_goal",
  REMEMBER: "remember",
  RECALL_MEMORY: "recall_memory",
  FORGET_MEMORY: "forget_memory",
  LIST_MEMORIES: "list_memories"
});

/**
 * 定义 ToolCallRuntime 类，封装当前模块的状态和行为。
 */
export class ToolCallRuntime {
  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} _toolCall - _toolCall 参数。
   * @param {unknown} _context - _context 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async run(_toolCall, _context = {}) {
    throw new Error("ToolCallRuntime.run() must be implemented by a subclass.");
  }
}

/**
 * 定义 NoopToolCallRuntime 类，封装当前模块的状态和行为。
 */
export class NoopToolCallRuntime extends ToolCallRuntime {
  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} toolCall - toolCall 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async run(toolCall) {
    return createToolCallResult({
      callId: toolCall.call_id ?? toolCall.callId,
      name: toolCall.name,
      status: TOOL_CALL_RESULT_STATUSES.FAILED,
      output: `tool execution is not implemented: ${toolCall.name}`,
      error: "not_implemented"
    });
  }
}

/**
 * 安全工具运行时。
 *
 * 它集中装配内置工具、工具 handler、审批 gate、sandbox policy、
 * MCP runtime、子 agent 协调器和 goal store，是模型 tool call 真正落地的入口。
 */
export class SafeToolCallRuntime extends ToolCallRuntime {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    super();
    this.allowApplyPatch = options.allowApplyPatch ?? false;
    this.allowApplyPatchWrites = options.allowApplyPatchWrites ?? false;
    this.allowShell = options.allowShell ?? false;
    this.applyPatchFileProvider = options.applyPatchFileProvider ?? null;
    this.applyPatchFsRuntime = options.applyPatchFsRuntime ?? null;
    this.approvalGate = options.approvalGate ?? null;
    this.permissionGrantStore = options.permissionGrantStore ?? null;
    this.serverRequestStore = options.serverRequestStore ?? null;
    this.execRunner = options.execRunner ?? new ExecRunner({
      workingDirectory: options.workingDirectory
    });
    this.commandSessionManager = options.commandSessionManager ?? new CommandSessionManager();
    this.mcpRuntime = options.mcpRuntime ?? null;
    this.agentCoordinator = options.agentCoordinator ?? new AgentCoordinator();
    this.goalStore = options.goalStore ?? new InMemoryGoalStore();
    this.memoryStore = options.memoryStore ?? new MemoryStore({
      memoryStoreDirectory: options.memoryStoreDirectory
    });
    this.workingDirectory = options.workingDirectory;
    const placeholderHandler = options.placeholderHandler ?? new PlaceholderToolHandler();
    this.router = options.router ?? new ToolRouter({
      registry: new ToolRegistry({
        tools: createBuiltinToolDefinitions({
          placeholderHandler,
          shellCommandHandler: new ShellCommandToolHandler({
            execRunner: this.execRunner,
            workingDirectory: options.workingDirectory,
            approvalGate: this.approvalGate,
            sandboxPolicy: options.sandboxPolicy,
            realExecution: this.allowShell
          }),
          execHandler: new ShellCommandToolHandler({
            execRunner: this.execRunner,
            workingDirectory: options.workingDirectory,
            approvalGate: this.approvalGate,
            sandboxPolicy: options.sandboxPolicy,
            realExecution: this.allowShell
          }),
          execCommandHandler: new ExecCommandToolHandler({
            commandSessionManager: this.commandSessionManager
          }),
          writeStdinHandler: new WriteStdinToolHandler({
            commandSessionManager: this.commandSessionManager
          }),
          listMcpResourcesHandler: new McpResourceToolHandler({
            mcpRuntime: this.mcpRuntime,
            kind: "list_resources"
          }),
          listMcpResourceTemplatesHandler: new McpResourceToolHandler({
            mcpRuntime: this.mcpRuntime,
            kind: "list_resource_templates"
          }),
          readMcpResourceHandler: new McpResourceToolHandler({
            mcpRuntime: this.mcpRuntime,
            kind: "read_resource"
          }),
          requestPermissionsHandler: options.requestPermissionsHandler ?? new RequestPermissionsToolHandler({
            approvalGate: this.approvalGate,
            permissionGrantStore: this.permissionGrantStore,
            serverRequestStore: this.serverRequestStore,
            workingDirectory: options.workingDirectory
          }),
          applyPatchHandler: new ApplyPatchToolHandler({
            allowApplyPatch: this.allowApplyPatch,
            allowApplyPatchWrites: this.allowApplyPatchWrites,
            applyPatchFileProvider: this.applyPatchFileProvider,
            applyPatchFsRuntime: this.applyPatchFsRuntime,
            approvalGate: this.approvalGate,
            sandboxPolicy: options.sandboxPolicy,
            workingDirectory: options.workingDirectory
          }),
          readFileHandler: new ReadFileToolHandler({
            sandboxPolicy: options.sandboxPolicy,
            workingDirectory: options.workingDirectory
          }),
          listFilesHandler: new ListFilesToolHandler({
            sandboxPolicy: options.sandboxPolicy,
            workingDirectory: options.workingDirectory
          }),
          searchFilesHandler: new SearchFilesToolHandler({
            sandboxPolicy: options.sandboxPolicy,
            workingDirectory: options.workingDirectory
          }),
          gitStatusHandler: new GitStatusToolHandler({
            execRunner: this.execRunner,
            approvalGate: this.approvalGate,
            requiresApproval: this.allowShell,
            sandboxPolicy: options.sandboxPolicy,
            workingDirectory: options.workingDirectory
          }),
          gitDiffHandler: new GitDiffToolHandler({
            execRunner: this.execRunner,
            approvalGate: this.approvalGate,
            requiresApproval: this.allowShell,
            sandboxPolicy: options.sandboxPolicy,
            workingDirectory: options.workingDirectory
          }),
          viewImageHandler: options.viewImageHandler ?? new ViewImageToolHandler({
            sandboxPolicy: options.sandboxPolicy,
            workingDirectory: options.workingDirectory
          }),
          toolSearchHandler: options.toolSearchHandler ?? new ToolSearchToolHandler(),
          planExpertsHandler: options.planExpertsHandler ?? new PlanExpertsToolHandler({
            expertProfiles: options.expertProfiles
          }),
          spawnAgentHandler: options.spawnAgentHandler ?? new SpawnAgentToolHandler({
            agentCoordinator: this.agentCoordinator,
            expertProfiles: options.expertProfiles
          }),
          waitAgentHandler: options.waitAgentHandler ?? new WaitAgentToolHandler({
            agentCoordinator: this.agentCoordinator
          }),
          getGoalHandler: options.getGoalHandler ?? new GoalToolHandler({
            goalStore: this.goalStore,
            kind: BUILTIN_TOOL_NAMES.GET_GOAL
          }),
          createGoalHandler: options.createGoalHandler ?? new GoalToolHandler({
            goalStore: this.goalStore,
            kind: BUILTIN_TOOL_NAMES.CREATE_GOAL
          }),
          updateGoalHandler: options.updateGoalHandler ?? new GoalToolHandler({
            goalStore: this.goalStore,
            kind: BUILTIN_TOOL_NAMES.UPDATE_GOAL
          }),
          rememberHandler: options.rememberHandler ?? new MemoryToolHandler({
            memoryStore: this.memoryStore,
            kind: BUILTIN_TOOL_NAMES.REMEMBER
          }),
          recallMemoryHandler: options.recallMemoryHandler ?? new MemoryToolHandler({
            memoryStore: this.memoryStore,
            kind: BUILTIN_TOOL_NAMES.RECALL_MEMORY
          }),
          forgetMemoryHandler: options.forgetMemoryHandler ?? new MemoryToolHandler({
            memoryStore: this.memoryStore,
            kind: BUILTIN_TOOL_NAMES.FORGET_MEMORY
          }),
          listMemoriesHandler: options.listMemoriesHandler ?? new MemoryToolHandler({
            memoryStore: this.memoryStore,
            kind: BUILTIN_TOOL_NAMES.LIST_MEMORIES
          }),
          webSearchHandler: options.webSearchHandler ?? new HostedProviderToolHandler({
            provider: options.webSearchProvider,
            kind: "web_search"
          }),
          imageGenerationHandler: options.imageGenerationHandler ?? new HostedProviderToolHandler({
            provider: options.imageGenerationProvider,
            kind: "image_generation"
          }),
          includeHostedTools: options.includeHostedTools ?? false
        })
      }),
      approvalGate: this.approvalGate,
      sandboxPolicy: options.sandboxPolicy
    });
  }

  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} toolCall - toolCall 参数。
   * @param {unknown} context - context 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async run(toolCall, context = {}) {
    return await this.router.run(toolCall, context);
  }

  /**
   * 执行 run shell command 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} request - request 参数。
   * @param {unknown} context - context 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async runShellCommand(request, context = {}) {
    return await this.router.run({
      ...request,
      name: request.name ?? BUILTIN_TOOL_NAMES.SHELL_COMMAND
    }, context);
  }

  /**
   * 执行 run apply patch 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} request - request 参数。
   * @param {unknown} context - context 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async runApplyPatch(request, context = {}) {
    return await this.router.run({
      ...request,
      name: request.name ?? BUILTIN_TOOL_NAMES.APPLY_PATCH
    }, context);
  }

  /**
   * 加载 load mcp tools 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async loadMcpTools(options = {}) {
    if (!this.mcpRuntime) {
      return [];
    }

    return await this.router.loadMcpRuntime(this.mcpRuntime, options);
  }
}

/**
 * 创建 create apply patch approval gate request 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createApplyPatchApprovalGateRequest(options = {}) {
  return {
    resourceType: APPROVAL_RESOURCE_TYPES.APPLY_PATCH,
    action: APPROVAL_ACTIONS.WRITE,
    subject: options.workingDirectory
      ? String(options.workingDirectory)
      : "workspace",
    description: "Apply patch to workspace files",
    metadata: {
      patch: String(options.patch ?? ""),
      workingDirectory: options.workingDirectory ?? null
    }
  };
}

/**
 * 创建 create request permissions approval gate request 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createRequestPermissionsApprovalGateRequest(options = {}) {
  return {
    resourceType: APPROVAL_RESOURCE_TYPES.TOOL,
    action: APPROVAL_ACTIONS.RUN,
    subject: BUILTIN_TOOL_NAMES.REQUEST_PERMISSIONS,
    description: "Request additional permissions",
    metadata: {
      threadId: options.threadId ?? null,
      turnId: options.turnId ?? null,
      itemId: options.itemId ?? null,
      environmentId: options.environmentId ?? options.environment_id ?? null,
      cwd: options.cwd ?? null,
      reason: options.reason ?? null,
      permissions: options.permissions ?? {}
    }
  };
}

/**
 * 创建 create tool call request 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createToolCallRequest(options = {}) {
  return {
    call_id: String(options.callId ?? options.call_id ?? ""),
    name: String(options.name ?? ""),
    arguments: normalizeToolArguments(options.arguments),
    raw: options.raw ?? null
  };
}

/**
 * 处理 command from tool arguments 相关逻辑。
 *
 * @param {unknown} args - args 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function commandFromToolArguments(args) {
  if (typeof args === "string") {
    return args;
  }

  if (Array.isArray(args?.command)) {
    return args.command.map((part) => String(part)).join(" ");
  }

  return String(args?.command ?? args?.cmd ?? "");
}

/**
 * 处理 patch from tool arguments 相关逻辑。
 *
 * @param {unknown} args - args 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function patchFromToolArguments(args) {
  if (typeof args === "string") {
    return args;
  }

  return String(args?.patch ?? args?.input ?? "");
}

/**
 * 创建 create tool call result 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createToolCallResult(options = {}) {
  return {
    call_id: String(options.callId ?? options.call_id ?? ""),
    name: String(options.name ?? ""),
    status: options.status ?? TOOL_CALL_RESULT_STATUSES.COMPLETED,
    output: String(options.output ?? ""),
    error: options.error ?? null,
    raw: options.raw ?? null
  };
}

/**
 * 归一化 normalize tool arguments 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeToolArguments(value) {
  if (value == null) {
    return {};
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return {};
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  return value;
}
