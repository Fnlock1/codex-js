/**
 * 中文模块说明：src/app-server/server.js
 *
 * app-server 总控，分发 thread、turn、fs、process、command、MCP 等 RPC 方法。
 */
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import {
  APPROVAL_ACTIONS,
  APPROVAL_DECISIONS,
  APPROVAL_RESOURCE_TYPES
} from "../approval/policy.js";
import { Codex } from "../codex.js";
import { ExecRunner } from "../exec/runner.js";
import {
  CommandSessionManager,
  normalizeExecCommandRequest,
  commandSessionResultToText
} from "../exec/session.js";
import { McpRuntime } from "../mcp/runtime.js";
import {
  capabilityRequestToApprovalRequest,
  createProcessSpawnCapabilityRequest
} from "../policy/capability.js";
import { SANDBOX_DECISIONS } from "../sandbox/policy.js";
import { SessionStore } from "../session-store.js";
import {
  batchWriteAppServerConfig,
  readAppServerConfig,
  readAppServerConfigRequirements,
  writeAppServerConfigValue
} from "./config.js";
import {
  ExperimentalFeatureEnablementStore,
  listExperimentalFeatures,
  setExperimentalFeatureEnablement
} from "./experimental-features.js";
import { AppServerFilesystemRuntime } from "./filesystem.js";
import {
  listPermissionProfiles
} from "./permission-profiles.js";
import {
  PermissionGrantStore
} from "./permissions.js";
import {
  BlockedProcessRuntime,
  createProcessOutputDeltaNotificationParams,
  normalizeProcessSpawnParams
} from "./processes.js";
import {
  APP_SERVER_ERROR_CODES,
  APP_SERVER_METHODS,
  APP_SERVER_NOTIFICATIONS,
  createAppServerProtocolError,
  createCommandExecView,
  createRpcError,
  createRpcSuccess,
  createThreadView,
  normalizeThreadStatus,
  normalizeRpcMessage,
  pageTurns,
  threadEventToAppServerNotification
} from "./protocol.js";
import {
  ServerRequestStore,
  approvalReviewDecisionFromServerResponse,
  createCommandExecutionApprovalServerRequest,
  permissionsResponseFromServerResponse
} from "./server-requests.js";
import {
  createThreadGoal,
  normalizeThreadGoal
} from "./thread-goal.js";
import {
  THREAD_STATUS_TYPES,
  TURN_CONTROL_STATUSES,
  createLoadedThreadEntry,
  createSteerMessage,
  createThreadStatus,
  createTurnControlRecord,
  normalizeThreadName
} from "./thread-state.js";

/**
 * 定义 CodexAppServer 类，封装当前模块的状态和行为。
 */
export class CodexAppServer {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.codex = options.codex ?? new Codex(options.codexOptions ?? options);
    this.mcpRuntime = options.mcpRuntime ?? new McpRuntime();
    this.execRunner = options.execRunner ?? new ExecRunner({
      workingDirectory: options.workingDirectory
    });
    this.commandSessionManager = options.commandSessionManager ?? new CommandSessionManager();
    this.approvalGate = options.approvalGate ?? null;
    this.sandboxPolicy = options.sandboxPolicy ?? null;
    this.permissionGrantStore = options.permissionGrantStore ?? new PermissionGrantStore();
    this.serverRequests = options.serverRequestStore ?? new ServerRequestStore({
      onRequest: (request) => this.emitServerRequest(request),
      onResolved: null
    });
    this.filesystemRuntime = options.filesystemRuntime ?? new AppServerFilesystemRuntime({
      workingDirectory: options.workingDirectory,
      allowWrites: options.allowFilesystemWrites ?? false,
      sandboxPolicy: this.sandboxPolicy,
      approvalGate: this.approvalGate,
      serverRequestStore: this.serverRequests,
      onChanged: (change) => {
        this.emit({
          method: APP_SERVER_NOTIFICATIONS.FS_CHANGED,
          params: {
            watchId: change.watchId,
            changedPaths: change.changedPaths,
            error: change.error
          }
        });
      }
    });
    this.processRuntime = options.processRuntime ?? new BlockedProcessRuntime();
    this.configPath = options.configPath ?? options.config_path ?? null;
    this.configOverrides = options.configOverrides ?? options.config ?? null;
    this.configRequirements = options.configRequirements ?? null;
    this.allowConfigWrites = Boolean(options.allowConfigWrites ?? options.allow_config_writes ?? false);
    this.experimentalFeatureEnablementStore =
      options.experimentalFeatureEnablementStore ??
      new ExperimentalFeatureEnablementStore(options.experimentalFeatureEnablement ?? {});
    this.codexHome = options.codexHome ?? null;
    this.sessionStore = options.sessionStore ?? new SessionStore({
      sessionStoreDirectory:
        options.sessionStoreDirectory ??
        options.codexOptions?.sessionStoreDirectory ??
        this.codex.options?.sessionStoreDirectory
    });
    this.userAgent = options.userAgent ?? "codex-js-app-server/0.1.0";
    this.platformFamily = options.platformFamily ?? platform();
    this.platformOs = options.platformOs ?? platform();
    this.initialized = false;
    this.experimentalApi = false;
    this.clientInfo = null;
    this.loadedThreads = new Map();
    this.threadSubscriptions = new Set();
    this.threadStatuses = new Map();
    this.activeTurns = new Map();
    this.notifications = [];
    this.serverRequestMessages = [];
    this.onNotification = options.onNotification ?? null;
    this.onServerRequest = options.onServerRequest ?? null;

    if (typeof this.commandSessionManager.setOutputDeltaHandler === "function") {
      this.commandSessionManager.setOutputDeltaHandler((delta) => {
        this.emit({
          method: APP_SERVER_NOTIFICATIONS.COMMAND_EXEC_OUTPUT_DELTA,
          params: createCommandExecOutputDeltaParams({
            result: {
              session_id: delta.session.id,
              process_id: delta.session.processId,
              command: delta.session.command,
              cwd: delta.session.cwd,
              exit_code: delta.session.exitCode,
              output: delta.delta,
              dry_run: delta.session.dryRun,
              error: delta.session.error
            },
            stream: delta.stream,
            deltaBase64: delta.deltaBase64,
            chunkId: delta.chunkId,
            capReached: delta.capReached
          })
        });
      });
    }

    if (typeof this.processRuntime === "object" && this.processRuntime) {
      this.processRuntime.onOutputDelta = (delta) => {
        this.emit({
          method: APP_SERVER_NOTIFICATIONS.PROCESS_OUTPUT_DELTA,
          params: createProcessOutputDeltaNotificationParams(delta)
        });
      };
      this.processRuntime.onExited = (exited) => {
        this.emit({
          method: APP_SERVER_NOTIFICATIONS.PROCESS_EXITED,
          params: exited
        });
      };
    }
  }

  /**
   * 处理传入请求或消息。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} message - message 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async handle(message) {
    let request;

    try {
      if (isRpcResponse(message)) {
        return this.handleServerResponse(message);
      }

      request = normalizeRpcMessage(message);
      const result = await this.dispatch(request);

      if (request.id == null) {
        return null;
      }

      return createRpcSuccess(request.id, result);
    } catch (error) {
      const id = request?.id ?? message?.id ?? null;

      return createRpcError(
        id,
        error.code ?? APP_SERVER_ERROR_CODES.INTERNAL_ERROR,
        error.message ?? "Internal error",
        error.data ?? null
      );
    }
  }

  /**
   * 根据请求方法分发到具体处理函数。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async dispatch(request) {
    if (request.method === APP_SERVER_METHODS.INITIALIZE) {
      return this.initialize(request.params);
    }

    if (!this.initialized) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.NOT_INITIALIZED,
        "Not initialized"
      );
    }

    switch (request.method) {
      case APP_SERVER_METHODS.INITIALIZED:
        return {};
      case APP_SERVER_METHODS.THREAD_START:
        return await this.threadStart(request.params);
      case APP_SERVER_METHODS.THREAD_RESUME:
        return await this.threadResume(request.params);
      case APP_SERVER_METHODS.THREAD_FORK:
        return await this.threadFork(request.params);
      case APP_SERVER_METHODS.THREAD_READ:
        return await this.threadRead(request.params);
      case APP_SERVER_METHODS.THREAD_LIST:
        return await this.threadList(request.params);
      case APP_SERVER_METHODS.THREAD_LOADED_LIST:
        return await this.threadLoadedList(request.params);
      case APP_SERVER_METHODS.THREAD_TURNS_LIST:
        return await this.threadTurnsList(request.params);
      case APP_SERVER_METHODS.THREAD_ARCHIVE:
        return await this.threadArchive(request.params);
      case APP_SERVER_METHODS.THREAD_UNARCHIVE:
        return await this.threadUnarchive(request.params);
      case APP_SERVER_METHODS.THREAD_UNSUBSCRIBE:
        return await this.threadUnsubscribe(request.params);
      case APP_SERVER_METHODS.THREAD_INJECT_ITEMS:
        return await this.threadInjectItems(request.params);
      case APP_SERVER_METHODS.THREAD_NAME_SET:
        return await this.threadNameSet(request.params);
      case APP_SERVER_METHODS.THREAD_GOAL_SET:
        return await this.threadGoalSet(request.params);
      case APP_SERVER_METHODS.THREAD_GOAL_GET:
        return await this.threadGoalGet(request.params);
      case APP_SERVER_METHODS.THREAD_GOAL_CLEAR:
        return await this.threadGoalClear(request.params);
      case APP_SERVER_METHODS.THREAD_ROLLBACK:
        return await this.threadRollback(request.params);
      case APP_SERVER_METHODS.THREAD_METADATA_UPDATE:
        return await this.threadMetadataUpdate(request.params);
      case APP_SERVER_METHODS.THREAD_SETTINGS_UPDATE:
        return await this.threadSettingsUpdate(request.params);
      case APP_SERVER_METHODS.THREAD_COMPACT_START:
        return await this.threadCompactStart(request.params);
      case APP_SERVER_METHODS.TURN_START:
        return await this.turnStart(request.params);
      case APP_SERVER_METHODS.TURN_STEER:
        return await this.turnSteer(request.params);
      case APP_SERVER_METHODS.TURN_INTERRUPT:
        return await this.turnInterrupt(request.params);
      case APP_SERVER_METHODS.COMMAND_EXEC:
        return await this.commandExec(request.params);
      case APP_SERVER_METHODS.COMMAND_EXEC_WRITE:
        return await this.commandExecWrite(request.params);
      case APP_SERVER_METHODS.COMMAND_EXEC_TERMINATE:
        return await this.commandExecTerminate(request.params);
      case APP_SERVER_METHODS.COMMAND_EXEC_RESIZE:
        return await this.commandExecResize(request.params);
      case APP_SERVER_METHODS.FS_READ_FILE:
        return await this.fsReadFile(request.params);
      case APP_SERVER_METHODS.FS_WRITE_FILE:
        return await this.fsWriteFile(request.params);
      case APP_SERVER_METHODS.FS_CREATE_DIRECTORY:
        return await this.fsCreateDirectory(request.params);
      case APP_SERVER_METHODS.FS_GET_METADATA:
        return await this.fsGetMetadata(request.params);
      case APP_SERVER_METHODS.FS_READ_DIRECTORY:
        return await this.fsReadDirectory(request.params);
      case APP_SERVER_METHODS.FS_REMOVE:
        return await this.fsRemove(request.params);
      case APP_SERVER_METHODS.FS_COPY:
        return await this.fsCopy(request.params);
      case APP_SERVER_METHODS.FS_WATCH:
        return await this.fsWatch(request.params);
      case APP_SERVER_METHODS.FS_UNWATCH:
        return await this.fsUnwatch(request.params);
      case APP_SERVER_METHODS.PROCESS_SPAWN:
        return await this.processSpawn(request.params);
      case APP_SERVER_METHODS.PROCESS_WRITE_STDIN:
        return await this.processWriteStdin(request.params);
      case APP_SERVER_METHODS.PROCESS_RESIZE_PTY:
        return await this.processResizePty(request.params);
      case APP_SERVER_METHODS.PROCESS_KILL:
        return await this.processKill(request.params);
      case APP_SERVER_METHODS.SERVER_REQUEST_LIST:
        return await this.serverRequestList(request.params);
      case APP_SERVER_METHODS.SERVER_REQUEST_RESOLVE:
        return await this.serverRequestResolve(request.params);
      case APP_SERVER_METHODS.PERMISSION_PROFILE_LIST:
        return await this.permissionProfileList(request.params);
      case APP_SERVER_METHODS.CONFIG_READ:
        return await this.configRead(request.params);
      case APP_SERVER_METHODS.CONFIG_VALUE_WRITE:
        return await this.configValueWrite(request.params);
      case APP_SERVER_METHODS.CONFIG_BATCH_WRITE:
        return await this.configBatchWrite(request.params);
      case APP_SERVER_METHODS.CONFIG_REQUIREMENTS_READ:
        return await this.configRequirementsRead(request.params);
      case APP_SERVER_METHODS.EXPERIMENTAL_FEATURE_LIST:
        return await this.experimentalFeatureList(request.params);
      case APP_SERVER_METHODS.EXPERIMENTAL_FEATURE_ENABLEMENT_SET:
        return await this.experimentalFeatureEnablementSet(request.params);
      case APP_SERVER_METHODS.MCP_SERVER_STATUS_LIST:
        return await this.mcpServerStatusList(request.params);
      case APP_SERVER_METHODS.MCP_RESOURCE_READ:
        return await this.mcpResourceRead(request.params);
      case APP_SERVER_METHODS.MCP_TOOL_CALL:
        return await this.mcpToolCall(request.params);
      default:
        throw createAppServerProtocolError(
          APP_SERVER_ERROR_CODES.METHOD_NOT_FOUND,
          `Method not found: ${request.method}`
        );
    }
  }

  /**
   * 初始化服务端状态并返回运行环境信息。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  initialize(params = {}) {
    if (this.initialized) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.ALREADY_INITIALIZED,
        "Already initialized"
      );
    }

    this.initialized = true;
    this.clientInfo = params.clientInfo ?? null;
    this.experimentalApi = Boolean(params.capabilities?.experimentalApi ?? false);

    return {
      userAgent: this.userAgent,
      codexHome: this.codexHome,
      platformFamily: this.platformFamily,
      platformOs: this.platformOs
    };
  }

  /**
   * 处理 thread start 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadStart(params = {}) {
    const thread = this.codex.startThread({
      workingDirectory: params.cwd,
      sessionStoreDirectory: params.sessionStoreDirectory,
      mockResponse: params.mockResponse,
      compaction: params.compaction
    });
    const session = await thread.ensureSession();

    this.loadedThreads.set(thread.id, thread);
    this.threadSubscriptions.add(thread.id);
    this.setThreadStatus(thread.id, createThreadStatus(THREAD_STATUS_TYPES.IDLE), {
      silent: true
    });
    const threadView = createThreadView(thread, session, {
      ephemeral: params.ephemeral
    });

    this.emit({
      method: "thread/started",
      params: {
        thread: threadView
      }
    });

    return {
      thread: threadView
    };
  }

  /**
   * 处理 thread resume 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadResume(params = {}) {
    const threadId = requireParam(params, "threadId");
    const thread = this.codex.resumeThread(threadId, {
      workingDirectory: params.cwd,
      sessionStoreDirectory: params.sessionStoreDirectory,
      compaction: params.compaction
    });
    const session = await thread.load();

    this.loadedThreads.set(thread.id, thread);
    this.threadSubscriptions.add(thread.id);
    this.setThreadStatus(thread.id, createThreadStatus(THREAD_STATUS_TYPES.IDLE), {
      silent: true
    });
    const threadView = createThreadView(thread, session, {
      includeTurns: params.excludeTurns ? false : true
    });

    this.emit({
      method: "thread/started",
      params: {
        thread: threadView
      }
    });

    return {
      thread: threadView
    };
  }

  /**
   * 处理 thread fork 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadFork(params = {}) {
    const threadId = requireParam(params, "threadId");
    const forkedSession = await this.sessionStore.fork(threadId, {
      workingDirectory: params.cwd
    });

    if (!forkedSession) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `Thread not found: ${threadId}`
      );
    }

    const thread = this.codex.resumeThread(forkedSession.threadId, {
      workingDirectory: forkedSession.workingDirectory ?? params.cwd,
      sessionStoreDirectory: this.sessionStore.root,
      compaction: params.compaction
    });

    this.loadedThreads.set(thread.id, thread);
    this.threadSubscriptions.add(thread.id);
    this.setThreadStatus(thread.id, createThreadStatus(THREAD_STATUS_TYPES.IDLE), {
      silent: true
    });

    const threadView = createThreadView(thread, forkedSession, {
      includeTurns: params.excludeTurns ? false : true,
      ephemeral: params.ephemeral,
      forkedFromId: threadId
    });

    this.emit({
      method: "thread/started",
      params: {
        thread: threadView
      }
    });

    return {
      thread: threadView
    };
  }

  /**
   * 处理 thread read 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadRead(params = {}) {
    const threadId = requireParam(params, "threadId");
    const thread = this.loadedThreads.get(threadId) ?? this.codex.resumeThread(threadId);
    const session = await thread.load() ?? await this.sessionStore.load(threadId, {
      includeArchived: true
    });

    return {
      thread: createThreadView(thread, session, {
        status: this.getThreadStatus(threadId, {
          loaded: this.loadedThreads.has(threadId)
        }),
        includeTurns: Boolean(params.includeTurns)
      })
    };
  }

  /**
   * 处理 thread list 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadList(params = {}) {
    const listed = await this.sessionStore.list({
      archived: params.archived === true,
      cursor: params.cursor,
      limit: params.limit,
      cwd: params.cwd,
      searchTerm: params.searchTerm
    });
    const loadedIds = new Set(this.loadedThreads.keys());

    return {
      threads: listed.sessions.map((session) => createThreadView(
        this.loadedThreads.get(session.threadId) ?? this.codex.resumeThread(session.threadId, {
          workingDirectory: session.workingDirectory ?? undefined,
          sessionStoreDirectory: this.sessionStore.root
        }),
        session,
        {
          includeTurns: false,
          status: this.getThreadStatus(session.threadId, {
            loaded: loadedIds.has(session.threadId)
          })
        }
      )),
      nextCursor: listed.nextCursor
    };
  }

  /**
   * 处理 thread turns list 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadTurnsList(params = {}) {
    const threadId = requireParam(params, "threadId");
    const thread = this.loadedThreads.get(threadId) ?? this.codex.resumeThread(threadId);
    const session = await thread.load();

    return pageTurns(session?.turns ?? [], {
      cursor: params.cursor,
      limit: params.limit,
      sortDirection: params.sortDirection,
      itemsView: params.itemsView
    });
  }

  /**
   * 处理 thread archive 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadArchive(params = {}) {
    const threadId = requireParam(params, "threadId");
    const session = await this.sessionStore.archive(threadId);

    if (!session) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `Thread not found: ${threadId}`
      );
    }

    this.loadedThreads.delete(threadId);
    this.threadSubscriptions.delete(threadId);
    this.threadStatuses.delete(threadId);
    this.clearActiveTurn(threadId, {
      status: TURN_CONTROL_STATUSES.INTERRUPTED
    });
    this.emit({
      method: APP_SERVER_NOTIFICATIONS.THREAD_ARCHIVED,
      params: {
        threadId
      }
    });

    return {};
  }

  /**
   * 处理 thread unarchive 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadUnarchive(params = {}) {
    const threadId = requireParam(params, "threadId");
    const session = await this.sessionStore.unarchive(threadId);

    if (!session) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `Thread not found: ${threadId}`
      );
    }

    const thread = this.codex.resumeThread(threadId, {
      workingDirectory: session.workingDirectory ?? undefined,
      sessionStoreDirectory: this.sessionStore.root
    });
    this.loadedThreads.set(threadId, thread);
    this.threadSubscriptions.add(threadId);
    this.setThreadStatus(threadId, createThreadStatus(THREAD_STATUS_TYPES.IDLE), {
      silent: true
    });

    this.emit({
      method: APP_SERVER_NOTIFICATIONS.THREAD_UNARCHIVED,
      params: {
        thread: createThreadView(thread, session, {
          includeTurns: false
        })
      }
    });

    return {
      thread: createThreadView(thread, session, {
        includeTurns: false
      })
    };
  }

  /**
   * 处理 thread loaded list 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadLoadedList() {
    const threads = [];

    for (const [threadId, thread] of this.loadedThreads.entries()) {
      const session = await this.sessionStore.load(threadId, {
        includeArchived: true
      }) ?? await thread.load();

      threads.push(createLoadedThreadEntry(thread, session, {
        status: this.getThreadStatus(threadId, {
          loaded: true
        })
      }));
    }

    return {
      threadIds: threads.map((thread) => thread.threadId),
      threads
    };
  }

  /**
   * 处理 thread unsubscribe 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadUnsubscribe(params = {}) {
    const threadId = requireParam(params, "threadId");

    if (!this.loadedThreads.has(threadId)) {
      return {
        status: "notLoaded"
      };
    }

    if (!this.threadSubscriptions.has(threadId)) {
      return {
        status: "notSubscribed"
      };
    }

    this.threadSubscriptions.delete(threadId);

    return {
      status: "unsubscribed"
    };
  }

  /**
   * 处理 thread inject items 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadInjectItems(params = {}) {
    const threadId = requireParam(params, "threadId");
    const items = params.items;

    if (!Array.isArray(items)) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        "thread/inject_items requires an items array",
        {
          reason: "invalid_items"
        }
      );
    }

    const thread = this.loadedThreads.get(threadId);

    if (!thread) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `Thread is not loaded: ${threadId}`,
        {
          reason: "thread_not_loaded",
          threadId
        }
      );
    }

    try {
      await thread.injectResponseItems(items);
    } catch (error) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        error.message ?? "invalid injected response items",
        {
          reason: "invalid_response_items",
          threadId
        }
      );
    }

    return {};
  }

  /**
   * 处理 thread name set 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadNameSet(params = {}) {
    const threadId = requireParam(params, "threadId");
    const name = normalizeThreadName(params.name ?? params.title);

    if (!name) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        "thread name must be a non-empty string",
        {
          reason: "invalid_thread_name"
        }
      );
    }

    const session = await this.sessionStore.updateMetadata(threadId, {
      name,
      title: name,
      namedAt: new Date().toISOString()
    });

    if (!session) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `Thread not found: ${threadId}`
      );
    }

    const thread = this.loadedThreads.get(threadId) ?? this.codex.resumeThread(threadId, {
      workingDirectory: session.workingDirectory ?? undefined,
      sessionStoreDirectory: this.sessionStore.root
    });
    const threadView = createThreadView(thread, session, {
      includeTurns: false,
      status: this.getThreadStatus(threadId, {
        loaded: this.loadedThreads.has(threadId)
      })
    });

    this.emit({
      method: APP_SERVER_NOTIFICATIONS.THREAD_NAME_UPDATED,
      params: {
        threadId,
        name,
        thread: threadView
      }
    });

    return {};
  }

  /**
   * 处理 thread goal set 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadGoalSet(params = {}) {
    const threadId = requireParam(params, "threadId");
    const session = await this.sessionStore.load(threadId, {
      includeArchived: true
    });

    if (!session) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `Thread not found: ${threadId}`
      );
    }

    let goal;

    try {
      goal = createThreadGoal({
        threadId,
        objective: params.objective ?? session.metadata?.goal?.objective,
        status: params.status ?? session.metadata?.goal?.status,
        tokenBudget: params.tokenBudget ?? params.token_budget ?? session.metadata?.goal?.tokenBudget,
        tokensUsed: session.metadata?.goal?.tokensUsed ?? 0,
        timeUsedSeconds: session.metadata?.goal?.timeUsedSeconds ?? 0,
        existing: session.metadata?.goal ?? null
      });
    } catch (error) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        error.message,
        {
          reason: "invalid_thread_goal"
        }
      );
    }

    await this.sessionStore.updateMetadata(threadId, {
      goal
    });

    this.emit({
      method: APP_SERVER_NOTIFICATIONS.THREAD_GOAL_UPDATED,
      params: {
        threadId,
        turnId: params.turnId ?? params.turn_id ?? null,
        goal
      }
    });

    return {
      goal
    };
  }

  /**
   * 处理 thread goal get 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadGoalGet(params = {}) {
    const threadId = requireParam(params, "threadId");
    const session = await this.sessionStore.load(threadId, {
      includeArchived: true
    });

    if (!session) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `Thread not found: ${threadId}`
      );
    }

    return {
      goal: normalizeThreadGoal(session.metadata?.goal ?? null, {
        threadId
      })
    };
  }

  /**
   * 处理 thread goal clear 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadGoalClear(params = {}) {
    const threadId = requireParam(params, "threadId");
    const session = await this.sessionStore.load(threadId, {
      includeArchived: true
    });

    if (!session) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `Thread not found: ${threadId}`
      );
    }

    const cleared = Boolean(session.metadata?.goal);
    const {
      goal: _goal,
      ...metadata
    } = session.metadata ?? {};

    if (cleared) {
      await this.sessionStore.replaceMetadata(threadId, metadata);
      this.emit({
        method: APP_SERVER_NOTIFICATIONS.THREAD_GOAL_CLEARED,
        params: {
          threadId
        }
      });
    }

    return {
      cleared
    };
  }

  /**
   * 处理 thread rollback 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadRollback(params = {}) {
    const threadId = requireParam(params, "threadId");
    const session = await this.sessionStore.rollback(threadId, {
      dropLastTurns: params.dropLastTurns ?? params.turns ?? 1
    });

    if (!session) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `Thread not found: ${threadId}`
      );
    }

    const thread = this.codex.resumeThread(threadId, {
      workingDirectory: session.workingDirectory ?? undefined,
      sessionStoreDirectory: this.sessionStore.root
    });

    this.loadedThreads.set(thread.id, thread);

    return {
      thread: createThreadView(thread, session, {
        includeTurns: true
      })
    };
  }

  /**
   * 处理 thread metadata update 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadMetadataUpdate(params = {}) {
    const threadId = requireParam(params, "threadId");
    const metadata = params.metadata ?? params.patch ?? {};

    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        "metadata must be an object"
      );
    }

    const session = await this.sessionStore.updateMetadata(threadId, metadata);

    if (!session) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `Thread not found: ${threadId}`
      );
    }

    const thread = this.codex.resumeThread(threadId, {
      workingDirectory: session.workingDirectory ?? undefined,
      sessionStoreDirectory: this.sessionStore.root
    });
    const threadView = createThreadView(thread, session, {
      includeTurns: false
    });

    this.emit({
      method: APP_SERVER_NOTIFICATIONS.THREAD_METADATA_UPDATED,
      params: {
        thread: threadView
      }
    });

    return {
      thread: threadView
    };
  }

  /**
   * 处理 thread settings update 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadSettingsUpdate(params = {}) {
    return await this.threadMetadataUpdate({
      threadId: params.threadId,
      metadata: {
        settings: {
          ...(params.settings ?? {})
        }
      }
    });
  }

  /**
   * 处理 thread compact start 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async threadCompactStart(params = {}) {
    const threadId = requireParam(params, "threadId");
    const session = await this.sessionStore.load(threadId, {
      includeArchived: true
    });

    if (!session) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `Thread not found: ${threadId}`
      );
    }

    const compacted = await this.sessionStore.updateMetadata(threadId, {
      compactRequestedAt: new Date().toISOString(),
      compactOptions: params.compaction ?? {}
    });
    const thread = this.codex.resumeThread(threadId, {
      workingDirectory: compacted.workingDirectory ?? undefined,
      sessionStoreDirectory: this.sessionStore.root
    });

    this.emit({
      method: APP_SERVER_NOTIFICATIONS.THREAD_COMPACTED,
      params: {
        threadId,
        dryRun: true
      }
    });

    return {
      thread: createThreadView(thread, compacted, {
        includeTurns: true
      }),
      dryRun: true
    };
  }

  /**
   * 处理 turn start 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async turnStart(params = {}) {
    const threadId = requireParam(params, "threadId");
    const input = params.input ?? params.prompt ?? "";
    const thread = this.loadedThreads.get(threadId) ?? this.codex.resumeThread(threadId, {
      workingDirectory: params.cwd
    });
    const turnId = params.turnId ?? randomUUID();

    this.loadedThreads.set(thread.id, thread);
    this.setActiveTurn(thread.id, createTurnControlRecord({
      threadId: thread.id,
      turnId,
      input
    }));
    this.setThreadStatus(thread.id, createThreadStatus(THREAD_STATUS_TYPES.ACTIVE));

    try {
      const streamed = await thread.runStreamed(input, {
        runtime: params.runtime
      });

      for await (const event of streamed.events) {
        const notification = threadEventToAppServerNotification(event, thread.id, turnId);

        if (notification) {
          this.emit(notification);
        }
      }
    } finally {
      const active = this.activeTurns.get(thread.id);

      if (active?.turnId === turnId) {
        this.clearActiveTurn(thread.id, {
          status: active.interruptRequested
            ? TURN_CONTROL_STATUSES.INTERRUPTED
            : TURN_CONTROL_STATUSES.COMPLETED
        });
      }

      this.setThreadStatus(thread.id, createThreadStatus(THREAD_STATUS_TYPES.IDLE));
    }

    const session = await thread.load();
    const turn = session?.turns?.at(-1) ?? null;

    return {
      turn: {
        id: turnId,
        threadId: thread.id,
        status: turn?.failed ? "failed" : "completed",
        input,
        items: turn?.items ?? []
      }
    };
  }

  /**
   * 处理 turn steer 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async turnSteer(params = {}) {
    const threadId = requireParam(params, "threadId");
    const active = this.activeTurns.get(threadId);

    if (!active || active.status !== TURN_CONTROL_STATUSES.ACTIVE) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `Thread has no active steerable turn: ${threadId}`,
        {
          reason: "turn_not_active",
          threadId
        }
      );
    }

    if (params.turnId && params.turnId !== active.turnId) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `Active turn id mismatch: ${params.turnId}`,
        {
          reason: "turn_id_mismatch",
          threadId,
          activeTurnId: active.turnId
        }
      );
    }

    const steerMessage = createSteerMessage({
      id: randomUUID(),
      clientId: params.clientUserMessageId ?? params.client_user_message_id,
      input: params.input ?? params.prompt ?? ""
    });

    active.steerMessages.push(steerMessage);

    this.emit({
      method: APP_SERVER_NOTIFICATIONS.ITEM_COMPLETED,
      params: {
        threadId,
        turnId: active.turnId,
        item: {
          id: steerMessage.id,
          clientId: steerMessage.clientId,
          type: "userMessage",
          status: "completed",
          content: [
            {
              type: "text",
              text: String(steerMessage.input ?? "")
            }
          ]
        }
      }
    });

    return {
      turnId: active.turnId
    };
  }

  /**
   * 处理 turn interrupt 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async turnInterrupt(params = {}) {
    const threadId = requireParam(params, "threadId");
    const turnId = requireAnyParam(params, ["turnId", "turn_id"]);
    const active = this.activeTurns.get(threadId);

    if (!active || active.turnId !== turnId) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `Active turn not found: ${threadId}/${turnId}`,
        {
          reason: "turn_not_active",
          threadId,
          turnId
        }
      );
    }

    active.interruptRequested = true;
    active.status = TURN_CONTROL_STATUSES.INTERRUPTED;

    this.emit({
      method: APP_SERVER_NOTIFICATIONS.TURN_COMPLETED,
      params: {
        threadId,
        turnId,
        status: "interrupted",
        interrupted: true
      }
    });
    this.clearActiveTurn(threadId, {
      status: TURN_CONTROL_STATUSES.INTERRUPTED
    });
    this.setThreadStatus(threadId, createThreadStatus(THREAD_STATUS_TYPES.IDLE));

    return {};
  }

  /**
   * 处理 mcp server status list 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
  async mcpServerStatusList() {
    return {
      servers: await this.mcpRuntime.listServerStatuses()
    };
  }

  /**
   * 处理 permission profile list 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async permissionProfileList(params = {}) {
    return listPermissionProfiles({
      cursor: params.cursor,
      limit: params.limit,
      cwd: params.cwd
    });
  }

  /**
   * 处理 config read 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async configRead(params = {}) {
    return await readAppServerConfig({
      configPath: params.configPath ?? params.config_path ?? this.configPath,
      cwd: params.cwd ?? null,
      includeLayers: params.includeLayers ?? params.include_layers,
      overrides: this.configOverrides,
      runtimeFeatureEnablement: this.experimentalFeatureEnablementStore.toJSON()
    });
  }

  /**
   * 处理 config value write 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async configValueWrite(params = {}) {
    return await writeAppServerConfigValue(params, {
      configPath: this.configPath,
      allowConfigWrites: this.allowConfigWrites
    });
  }

  /**
   * 处理 config batch write 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async configBatchWrite(params = {}) {
    return await batchWriteAppServerConfig(params, {
      configPath: this.configPath,
      allowConfigWrites: this.allowConfigWrites
    });
  }

  /**
   * 处理 config requirements read 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   * @returns {unknown} 返回处理后的结果。
   */
  async configRequirementsRead() {
    return await readAppServerConfigRequirements({
      requirements: this.configRequirements
    });
  }

  /**
   * 处理 experimental feature list 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async experimentalFeatureList(params = {}) {
    if (params.threadId ?? params.thread_id) {
      const threadId = params.threadId ?? params.thread_id;

      if (!this.loadedThreads.has(threadId)) {
        throw createAppServerProtocolError(
          APP_SERVER_ERROR_CODES.INVALID_REQUEST,
          `thread not found: ${threadId}`,
          {
            reason: "thread_not_found",
            threadId
          }
        );
      }
    }

    return listExperimentalFeatures(params, {
      runtimeEnablement: this.experimentalFeatureEnablementStore.toJSON(),
      configFeatures: this.configOverrides?.features ?? {}
    });
  }

  /**
   * 处理 experimental feature enablement set 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async experimentalFeatureEnablementSet(params = {}) {
    return setExperimentalFeatureEnablement(params, this.experimentalFeatureEnablementStore);
  }

  /**
   * 处理 command exec 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async commandExec(params = {}) {
    const command = params.command ?? params.cmd ?? params.argv;
    const events = [];
    let result = null;

    if (!command) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        "Missing required param: command"
      );
    }

    if (params.tty || params.stream_stdin || params.streamStdin || params.stream_stdout_stderr || params.streamStdoutStderr) {
      const sessionRequest = {
        command,
        workdir: params.cwd ?? params.workdir,
        processId: params.processId ?? params.process_id,
        tty: params.tty,
        stream_stdin: params.stream_stdin ?? params.streamStdin,
        yield_time_ms: params.yield_time_ms ?? params.yieldTimeMs,
        max_output_tokens: params.max_output_tokens ?? params.maxOutputTokens
      };
      const gate = this.checkCommandSessionStart(sessionRequest);

      if (!gate.allowed) {
        throw createAppServerProtocolError(
          APP_SERVER_ERROR_CODES.INVALID_PARAMS,
          gate.message,
          gate
        );
      }

      const sessionResult = this.commandSessionManager.start(sessionRequest);

      if (sessionResult.error) {
        throw createAppServerProtocolError(
          APP_SERVER_ERROR_CODES.INVALID_PARAMS,
          sessionResult.output || sessionResult.error,
          sessionResult
        );
      }

      if (sessionResult.output) {
        this.emit({
          method: APP_SERVER_NOTIFICATIONS.COMMAND_EXEC_OUTPUT_DELTA,
          params: createCommandExecOutputDeltaParams({
            command,
            result: sessionResult,
            stream: "stdout"
          })
        });
      }

      return {
        command: {
          status: sessionResult.error ? "failed" : "completed",
          exitCode: sessionResult.exit_code,
          output: sessionResult.output,
          error: sessionResult.error,
          dryRun: Boolean(sessionResult.dry_run),
          sessionId: sessionResult.session_id,
          processId: sessionResult.process_id
        },
        output: commandSessionResultToText(sessionResult),
        session: sessionResult,
        events
      };
    }

    const iterator = this.execRunner.runCommand({
      command,
      argv: params.argv,
      cwd: params.cwd ?? params.workdir,
      timeoutMs: params.timeoutMs ?? params.timeout_ms,
      env: params.env
    });
    let next = await iterator.next();

    while (!next.done) {
      events.push(next.value);
      const notification = threadEventToAppServerNotification(next.value, params.threadId ?? null, params.turnId ?? null);

      if (notification) {
        this.emit(notification);
      }

      if (next.value?.item?.aggregated_output) {
        this.emit({
          method: APP_SERVER_NOTIFICATIONS.COMMAND_EXEC_OUTPUT_DELTA,
          params: {
            command,
            output: next.value.item.aggregated_output,
            deltaBase64: Buffer.from(String(next.value.item.aggregated_output ?? "")).toString("base64"),
            delta_base64: Buffer.from(String(next.value.item.aggregated_output ?? "")).toString("base64"),
            stream: "stdout",
            exitCode: next.value.item.exit_code
          }
        });
      }

      next = await iterator.next();
    }

    result = next.value;

    return {
      command: createCommandExecView(result),
      events
    };
  }

  /**
   * 处理 command exec write 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async commandExecWrite(params = {}) {
    const result = this.commandSessionManager.write({
      session_id: requireAnyParam(params, ["sessionId", "session_id", "processId", "process_id"]),
      chars: decodeBase64Param(params.deltaBase64 ?? params.delta_base64) ?? params.chars ?? "",
      close_stdin: params.closeStdin ?? params.close_stdin ?? false,
      yield_time_ms: params.yield_time_ms ?? params.yieldTimeMs,
      max_output_tokens: params.max_output_tokens ?? params.maxOutputTokens
    });

    if (result.error) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        result.output || result.error,
        result
      );
    }

    this.emit({
      method: APP_SERVER_NOTIFICATIONS.COMMAND_EXEC_OUTPUT_DELTA,
      params: createCommandExecOutputDeltaParams({
        result,
        stream: "stdout"
      })
    });

    return {
      output: commandSessionResultToText(result),
      session: result
    };
  }

  /**
   * 处理 command exec terminate 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async commandExecTerminate(params = {}) {
    if (typeof this.commandSessionManager.terminate !== "function") {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        "command session termination is not supported by this manager"
      );
    }

    const result = this.commandSessionManager.terminate(
      requireAnyParam(params, ["sessionId", "session_id", "processId", "process_id"])
    );

    if (result.error) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        result.output || result.error,
        result
      );
    }

    return {
      session: result
    };
  }

  /**
   * 处理 command exec resize 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async commandExecResize(params = {}) {
    if (typeof this.commandSessionManager.resize !== "function") {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        "command session resize is not supported by this manager"
      );
    }

    const result = this.commandSessionManager.resize({
      session_id: requireAnyParam(params, ["sessionId", "session_id", "processId", "process_id"]),
      size: params.size ?? {
        rows: params.rows,
        cols: params.cols ?? params.columns
      }
    });

    if (result.error) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        result.output || result.error,
        result
      );
    }

    return {
      session: result
    };
  }

  /**
   * 处理 fs read file 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async fsReadFile(params = {}) {
    return await this.filesystemRuntime.readFile(params);
  }

  /**
   * 处理 fs write file 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async fsWriteFile(params = {}) {
    return await this.filesystemRuntime.writeFile(params);
  }

  /**
   * 处理 fs create directory 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async fsCreateDirectory(params = {}) {
    return await this.filesystemRuntime.createDirectory(params);
  }

  /**
   * 处理 fs get metadata 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async fsGetMetadata(params = {}) {
    return await this.filesystemRuntime.getMetadata(params);
  }

  /**
   * 处理 fs read directory 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async fsReadDirectory(params = {}) {
    return await this.filesystemRuntime.readDirectory(params);
  }

  /**
   * 处理 fs remove 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async fsRemove(params = {}) {
    return await this.filesystemRuntime.remove(params);
  }

  /**
   * 处理 fs copy 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async fsCopy(params = {}) {
    return await this.filesystemRuntime.copy(params);
  }

  /**
   * 处理 fs watch 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async fsWatch(params = {}) {
    return await this.filesystemRuntime.watch(params);
  }

  /**
   * 处理 fs unwatch 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async fsUnwatch(params = {}) {
    return await this.filesystemRuntime.unwatch(params);
  }

  /**
   * 处理 process spawn 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async processSpawn(params = {}) {
    this.assertExperimentalApi(APP_SERVER_METHODS.PROCESS_SPAWN);

    if (this.approvalGate) {
      const normalized = normalizeProcessSpawnParams(params);
      const command = normalized.command.join(" ");
      const capability = createProcessSpawnCapabilityRequest({
        commandText: command,
        argv: normalized.command,
        cwd: normalized.cwd,
        env: normalized.env,
        processHandle: normalized.processHandle
      });
      const approval = this.approvalGate.check(capabilityRequestToApprovalRequest(capability));

      if (approval.decision !== APPROVAL_DECISIONS.ALLOW) {
        const serverRequest = approval.decision === APPROVAL_DECISIONS.PROMPT
          ? this.serverRequests.create(createCommandExecutionApprovalServerRequest({
              approval,
              command,
              cwd: normalized.cwd,
              reason: approval.approvalRequest?.description ?? `Spawn process: ${command}`
            }))
          : null;

        throw createAppServerProtocolError(
          APP_SERVER_ERROR_CODES.INVALID_PARAMS,
          approval.decision === APPROVAL_DECISIONS.PROMPT
            ? "approval required before spawning process"
            : "process spawn forbidden by approval policy",
          {
            reason: approval.decision === APPROVAL_DECISIONS.PROMPT
              ? "approval_required"
              : "approval_forbidden",
            method: APP_SERVER_METHODS.PROCESS_SPAWN,
            processHandle: normalized.processHandle,
            command,
            approval,
            capability,
            requestId: serverRequest?.requestId ?? null,
            serverRequest: serverRequest ? {
              requestId: serverRequest.requestId,
              method: serverRequest.method,
              params: serverRequest.params
            } : null
          }
        );
      }
    }

    return await this.processRuntime.spawn(params);
  }

  /**
   * 处理 process write stdin 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async processWriteStdin(params = {}) {
    this.assertExperimentalApi(APP_SERVER_METHODS.PROCESS_WRITE_STDIN);
    return await this.processRuntime.writeStdin(params);
  }

  /**
   * 处理 process resize pty 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async processResizePty(params = {}) {
    this.assertExperimentalApi(APP_SERVER_METHODS.PROCESS_RESIZE_PTY);
    return await this.processRuntime.resizePty(params);
  }

  /**
   * 处理 process kill 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async processKill(params = {}) {
    this.assertExperimentalApi(APP_SERVER_METHODS.PROCESS_KILL);
    return await this.processRuntime.kill(params);
  }

  /**
   * 处理 mcp resource read 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async mcpResourceRead(params = {}) {
    return await this.mcpRuntime.readResource({
      server: requireParam(params, "server"),
      uri: requireParam(params, "uri")
    });
  }

  /**
   * 处理 mcp tool call 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async mcpToolCall(params = {}) {
    const result = await this.mcpRuntime.callTool({
      call_id: params.callId ?? params.call_id ?? randomUUID(),
      name: `mcp__${params.server}__${params.tool}`,
      server: requireParam(params, "server"),
      tool: requireParam(params, "tool"),
      arguments: params.arguments ?? {}
    });

    return {
      result
    };
  }

  /**
   * 处理 server request list 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async serverRequestList(params = {}) {
    return this.serverRequests.list({
      threadId: params.threadId ?? null
    });
  }

  /**
   * 处理 server request resolve 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async serverRequestResolve(params = {}) {
    const requestId = requireAnyParam(params, ["requestId", "request_id"]);
    const response = params.response ?? {
      decision: params.decision ?? "cancel"
    };
    const result = this.resolveServerRequest(requestId, response);

    if (!result) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `server request not found: ${requestId}`,
        {
          reason: "server_request_not_found",
          requestId
        }
      );
    }

    return {
      request: {
        requestId: result.resolved.requestId,
        threadId: result.resolved.threadId,
        kind: result.resolved.kind,
        resolvedAtMs: result.resolved.resolvedAtMs
      }
    };
  }

  /**
   * 处理 handle server response 相关逻辑。
   *
   * @param {unknown} message - message 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  handleServerResponse(message = {}) {
    const response = message.error
      ? {
          decision: "cancel",
          error: message.error
        }
      : message.result ?? {};
    const result = this.resolveServerRequest(message.id, response);

    if (!result) {
      return createRpcError(
        message.id ?? null,
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `server request not found: ${message.id}`,
        {
          reason: "server_request_not_found",
          requestId: message.id ?? null
        }
      );
    }

    return null;
  }

  /**
   * 解析 resolve server request 相关数据。
   *
   * @param {unknown} requestId - requestId 参数。
   * @param {unknown} response - response 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  resolveServerRequest(requestId, response = {}) {
    const result = this.serverRequests.resolve(requestId, response);

    if (!result) {
      return null;
    }

    this.emit({
      method: APP_SERVER_NOTIFICATIONS.SERVER_REQUEST_RESOLVED,
      params: {
        threadId: result.resolved.threadId,
        requestId: result.resolved.requestId
      }
    });

    if (this.approvalGate && result.pending.approval) {
      this.approvalGate.review(
        result.pending.approval.approvalRequest ?? result.pending.approval,
        approvalReviewDecisionFromServerResponse(response)
      );
    }

    if (result.pending.kind === "permissions_approval") {
      const permissionsResponse = permissionsResponseFromServerResponse(result.pending, response);

      this.permissionGrantStore.add({
        threadId: result.pending.threadId,
        turnId: result.pending.turnId,
        itemId: result.pending.itemId,
        environmentId: result.pending.params?.environmentId,
        cwd: result.pending.params?.cwd,
        reason: result.pending.params?.reason,
        requested: result.pending.params?.permissions,
        granted: permissionsResponse.permissions,
        scope: permissionsResponse.scope,
        strictAutoReview: permissionsResponse.strictAutoReview
      });
    }

    return result;
  }

  /**
   * 发送 emit 相关数据。
   *
   * @param {unknown} notification - notification 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  emit(notification) {
    this.notifications.push(notification);

    if (this.onNotification) {
      this.onNotification(notification);
    }
  }

  /**
   * 发送 emit server request 相关数据。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  emitServerRequest(request) {
    this.serverRequestMessages.push(request.envelope);

    if (this.onServerRequest) {
      this.onServerRequest(request.envelope, request);
    }
  }

  /**
   * 获取 get thread status 相关数据。
   *
   * @param {unknown} threadId - threadId 参数。
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  getThreadStatus(threadId, options = {}) {
    if (!options.loaded) {
      return createThreadStatus(THREAD_STATUS_TYPES.NOT_LOADED);
    }

    return this.threadStatuses.get(threadId) ?? createThreadStatus(THREAD_STATUS_TYPES.IDLE);
  }

  /**
   * 设置 set thread status 相关数据。
   *
   * @param {unknown} threadId - threadId 参数。
   * @param {unknown} status - status 参数。
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  setThreadStatus(threadId, status, options = {}) {
    const normalized = normalizeThreadStatus(status);
    this.threadStatuses.set(threadId, normalized);

    if (options.silent) {
      return;
    }

    this.emit({
      method: APP_SERVER_NOTIFICATIONS.THREAD_STATUS_CHANGED,
      params: {
        threadId,
        status: normalized
      }
    });
  }

  /**
   * 设置 set active turn 相关数据。
   *
   * @param {unknown} threadId - threadId 参数。
   * @param {unknown} record - record 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  setActiveTurn(threadId, record) {
    this.activeTurns.set(threadId, record);
  }

  /**
   * 处理 clear active turn 相关逻辑。
   *
   * @param {unknown} threadId - threadId 参数。
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  clearActiveTurn(threadId, options = {}) {
    const active = this.activeTurns.get(threadId);

    if (active) {
      active.status = options.status ?? active.status;
      active.completedAtMs = Date.now();
    }

    this.activeTurns.delete(threadId);
    return active ?? null;
  }

  /**
   * 处理 check command session start 相关逻辑。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  checkCommandSessionStart(request = {}) {
    const normalized = normalizeExecCommandRequest(request);

    if (this.sandboxPolicy) {
      const sandbox = this.sandboxPolicy.checkExec({
        command: normalized.command,
        argv: normalized.argv,
        cwd: normalized.cwd,
        timeout_ms: normalized.timeout_ms,
        env: normalized.env
      });

      if (sandbox.decision !== SANDBOX_DECISIONS.ALLOW) {
        return {
          allowed: false,
          reason: "sandbox_denied",
          message: `sandbox blocked: ${sandbox.reason}`,
          sandbox
        };
      }
    }

    if (this.approvalGate) {
      const approval = this.approvalGate.check({
        resourceType: APPROVAL_RESOURCE_TYPES.EXEC,
        action: APPROVAL_ACTIONS.EXECUTE,
        subject: normalized.command,
        description: `Execute command session: ${normalized.command}`,
        metadata: {
          command: normalized.command,
          cwd: normalized.cwd,
          argv: normalized.argv ?? null,
          processId: normalized.processId,
          tty: normalized.tty,
          streamStdin: normalized.streamStdin
        }
      });

      if (approval.decision !== APPROVAL_DECISIONS.ALLOW) {
        const serverRequest = approval.decision === APPROVAL_DECISIONS.PROMPT
          ? this.serverRequests.create(createCommandExecutionApprovalServerRequest({
              approval,
              command: normalized.command,
              cwd: normalized.cwd,
              reason: approval.approvalRequest?.description ?? `Execute command session: ${normalized.command}`
            }))
          : null;

        return {
          allowed: false,
          reason: approval.decision === APPROVAL_DECISIONS.PROMPT
            ? "approval_required"
            : "approval_forbidden",
          message: approval.decision === APPROVAL_DECISIONS.PROMPT
            ? "approval required before starting command session"
            : "command session forbidden by approval policy",
          approval,
          requestId: serverRequest?.requestId ?? null,
          serverRequest: serverRequest ? {
            requestId: serverRequest.requestId,
            method: serverRequest.method,
            params: serverRequest.params
          } : null
        };
      }
    }

    return {
      allowed: true
    };
  }

  /**
   * 断言 assert experimental api 相关数据。
   *
   * @param {unknown} method - method 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  assertExperimentalApi(method) {
    if (!this.experimentalApi) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `${method} requires experimentalApi capability`,
        {
          reason: "experimental_api_required",
          method
        }
      );
    }
  }
}

/**
 * 创建 create codex app server 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createCodexAppServer(options = {}) {
  return new CodexAppServer(options);
}

/**
 * 处理 require param 相关逻辑。
 *
 * @param {unknown} params - params 参数。
 * @param {unknown} name - name 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function requireParam(params, name) {
  const value = params?.[name];

  if (value == null || value === "") {
    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_PARAMS,
      `Missing required param: ${name}`
    );
  }

  return value;
}

/**
 * 处理 require any param 相关逻辑。
 *
 * @param {unknown} params - params 参数。
 * @param {unknown} names - names 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function requireAnyParam(params, names) {
  for (const name of names) {
    const value = params?.[name];

    if (value != null && value !== "") {
      return value;
    }
  }

  throw createAppServerProtocolError(
    APP_SERVER_ERROR_CODES.INVALID_PARAMS,
    `Missing required param: ${names.join(" or ")}`
  );
}

/**
 * 解码 decode base64 param 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function decodeBase64Param(value) {
  if (value == null || value === "") {
    return null;
  }

  return Buffer.from(String(value), "base64").toString("utf8");
}

/**
 * 判断是否为 is rpc response 相关数据。
 *
 * @param {unknown} message - message 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function isRpcResponse(message) {
  return Boolean(
    message &&
    typeof message === "object" &&
    message.id != null &&
    typeof message.method !== "string" &&
    (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
  );
}

/**
 * 创建 create command exec output delta params 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function createCommandExecOutputDeltaParams(options = {}) {
  const result = options.result ?? {};
  const output = String(result.output ?? "");
  const deltaBase64 = options.deltaBase64 ?? Buffer.from(output).toString("base64");

  return {
    command: options.command,
    sessionId: result.session_id,
    session_id: result.session_id,
    processId: result.process_id,
    process_id: result.process_id,
    chunkId: options.chunkId ?? result.chunk_id ?? null,
    chunk_id: options.chunkId ?? result.chunk_id ?? null,
    stream: options.stream ?? "stdout",
    deltaBase64,
    delta_base64: deltaBase64,
    capReached: Boolean(options.capReached ?? false),
    cap_reached: Boolean(options.capReached ?? false),
    output: {
      text: output
    },
    exitCode: result.exit_code,
    exit_code: result.exit_code
  };
}
