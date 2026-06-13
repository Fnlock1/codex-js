/**
 * 中文模块说明：src/app-server/filesystem.js
 *
 * 面向 UI 或守护进程的 JSONL/RPC app-server 协议层。
 */
import {
  watch as watchFs
} from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  lstat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import {
  APPROVAL_DECISIONS
} from "../approval/policy.js";
import {
  capabilityRequestToApprovalRequest,
  createFilesystemWriteCapabilityRequest
} from "../policy/capability.js";
import {
  SANDBOX_ACCESS_TYPES,
  SANDBOX_DECISIONS,
  normalizeSandboxPath
} from "../sandbox/policy.js";
import {
  APP_SERVER_ERROR_CODES,
  createAppServerProtocolError
} from "./protocol.js";
import {
  createFileChangeApprovalServerRequest
} from "./server-requests.js";

export const APP_SERVER_FS_METHODS = Object.freeze({
  READ_FILE: "fs/readFile",
  WRITE_FILE: "fs/writeFile",
  CREATE_DIRECTORY: "fs/createDirectory",
  GET_METADATA: "fs/getMetadata",
  READ_DIRECTORY: "fs/readDirectory",
  REMOVE: "fs/remove",
  COPY: "fs/copy",
  WATCH: "fs/watch",
  UNWATCH: "fs/unwatch"
});

export const FS_WRITE_OPERATIONS = new Set([
  APP_SERVER_FS_METHODS.WRITE_FILE,
  APP_SERVER_FS_METHODS.CREATE_DIRECTORY,
  APP_SERVER_FS_METHODS.REMOVE,
  APP_SERVER_FS_METHODS.COPY
]);

/**
 * 定义 AppServerFilesystemRuntime 类，封装当前模块的状态和行为。
 */
export class AppServerFilesystemRuntime {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.workingDirectory = options.workingDirectory ?? process.cwd();
    this.allowWrites = Boolean(options.allowWrites ?? false);
    this.sandboxPolicy = options.sandboxPolicy ?? null;
    this.approvalGate = options.approvalGate ?? null;
    this.serverRequestStore = options.serverRequestStore ?? null;
    this.onChanged = options.onChanged ?? null;
    this.watchers = new Map();
  }

  /**
   * 读取 read file 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async readFile(params = {}) {
    const filePath = this.resolvePath(requireFsParam(params, "path"));
    this.assertAllowed({
      method: APP_SERVER_FS_METHODS.READ_FILE,
      path: filePath,
      accessType: SANDBOX_ACCESS_TYPES.READ
    });

    const data = await readFile(filePath);

    return {
      dataBase64: data.toString("base64")
    };
  }

  /**
   * 写入 write file 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async writeFile(params = {}) {
    const filePath = this.resolvePath(requireFsParam(params, "path"));
    this.assertAllowed({
      method: APP_SERVER_FS_METHODS.WRITE_FILE,
      path: filePath,
      accessType: SANDBOX_ACCESS_TYPES.WRITE,
      requiresWriteGate: true
    });

    await writeFile(filePath, Buffer.from(requireFsParam(params, "dataBase64"), "base64"));
    return {};
  }

  /**
   * 创建 create directory 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async createDirectory(params = {}) {
    const directoryPath = this.resolvePath(requireFsParam(params, "path"));
    this.assertAllowed({
      method: APP_SERVER_FS_METHODS.CREATE_DIRECTORY,
      path: directoryPath,
      accessType: SANDBOX_ACCESS_TYPES.WRITE,
      requiresWriteGate: true
    });

    await mkdir(directoryPath, {
      recursive: params.recursive ?? true
    });
    return {};
  }

  /**
   * 获取 get metadata 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async getMetadata(params = {}) {
    const filePath = this.resolvePath(requireFsParam(params, "path"));
    this.assertAllowed({
      method: APP_SERVER_FS_METHODS.GET_METADATA,
      path: filePath,
      accessType: SANDBOX_ACCESS_TYPES.READ
    });

    const [pathStat, linkStat] = await Promise.all([
      stat(filePath),
      lstat(filePath)
    ]);

    return {
      isDirectory: pathStat.isDirectory(),
      isFile: pathStat.isFile(),
      isSymlink: linkStat.isSymbolicLink(),
      createdAtMs: Math.max(0, pathStat.birthtimeMs || 0),
      modifiedAtMs: Math.max(0, pathStat.mtimeMs || 0)
    };
  }

  /**
   * 读取 read directory 相关数据。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async readDirectory(params = {}) {
    const directoryPath = this.resolvePath(requireFsParam(params, "path"));
    this.assertAllowed({
      method: APP_SERVER_FS_METHODS.READ_DIRECTORY,
      path: directoryPath,
      accessType: SANDBOX_ACCESS_TYPES.READ
    });

    const entries = await readdir(directoryPath, {
      withFileTypes: true
    });

    return {
      entries: entries.map((entry) => ({
        fileName: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile()
      }))
    };
  }

  /**
   * 处理 remove 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async remove(params = {}) {
    const targetPath = this.resolvePath(requireFsParam(params, "path"));
    this.assertAllowed({
      method: APP_SERVER_FS_METHODS.REMOVE,
      path: targetPath,
      accessType: SANDBOX_ACCESS_TYPES.WRITE,
      requiresWriteGate: true
    });

    await rm(targetPath, {
      recursive: params.recursive ?? true,
      force: params.force ?? true
    });
    return {};
  }

  /**
   * 处理 copy 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async copy(params = {}) {
    const sourcePath = this.resolvePath(requireFsParam(params, "sourcePath"));
    const destinationPath = this.resolvePath(requireFsParam(params, "destinationPath"));
    this.assertAllowed({
      method: APP_SERVER_FS_METHODS.COPY,
      path: sourcePath,
      accessType: SANDBOX_ACCESS_TYPES.READ
    });
    this.assertAllowed({
      method: APP_SERVER_FS_METHODS.COPY,
      path: destinationPath,
      accessType: SANDBOX_ACCESS_TYPES.WRITE,
      requiresWriteGate: true
    });

    const sourceStat = await stat(sourcePath);

    if (sourceStat.isDirectory()) {
      await cp(sourcePath, destinationPath, {
        recursive: params.recursive === true
      });
    } else {
      await copyFile(sourcePath, destinationPath);
    }

    return {};
  }

  /**
   * 处理 watch 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async watch(params = {}) {
    const watchId = String(requireFsParam(params, "watchId"));
    const watchPath = this.resolvePath(requireFsParam(params, "path"));

    if (this.watchers.has(watchId)) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `fs watch already exists: ${watchId}`,
        {
          reason: "duplicate_watch_id",
          watchId
        }
      );
    }

    this.assertAllowed({
      method: APP_SERVER_FS_METHODS.WATCH,
      path: watchPath,
      accessType: SANDBOX_ACCESS_TYPES.READ
    });

    const watchStat = await stat(watchPath);
    const watcher = watchFs(watchPath, {
      persistent: false
    }, (_eventType, filename) => {
      this.emitChanged({
        watchId,
        watchPath,
        isDirectory: watchStat.isDirectory(),
        filename
      });
    });

    watcher.on("error", (error) => {
      this.emitChanged({
        watchId,
        watchPath,
        error
      });
    });

    this.watchers.set(watchId, {
      watchId,
      path: watchPath,
      isDirectory: watchStat.isDirectory(),
      watcher
    });

    return {
      path: watchPath
    };
  }

  /**
   * 处理 unwatch 相关逻辑。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async unwatch(params = {}) {
    const watchId = String(requireFsParam(params, "watchId"));
    const entry = this.watchers.get(watchId);

    if (!entry) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `fs watch not found: ${watchId}`,
        {
          reason: "watch_not_found",
          watchId
        }
      );
    }

    entry.watcher.close();
    this.watchers.delete(watchId);
    return {};
  }

  /**
   * 处理 close all watchers 相关逻辑。
   * @returns {unknown} 返回处理后的结果。
   */
  closeAllWatchers() {
    for (const entry of this.watchers.values()) {
      entry.watcher.close();
    }

    this.watchers.clear();
  }

  /**
   * 发送 emit changed 相关数据。
   *
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  emitChanged(options = {}) {
    if (!this.onChanged) {
      return;
    }

    const changedPath = options.filename && options.isDirectory
      ? path.resolve(options.watchPath, String(options.filename))
      : options.watchPath;

    this.onChanged({
      watchId: options.watchId,
      changedPaths: [changedPath],
      error: options.error
        ? {
            message: options.error.message,
            code: options.error.code ?? null
          }
        : null
    });
  }

  /**
   * 解析 resolve path 相关数据。
   *
   * @param {unknown} value - value 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  resolvePath(value) {
    const text = String(value ?? "");

    if (!path.isAbsolute(text)) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        "fs path must be absolute",
        {
          path: text
        }
      );
    }

    return normalizeSandboxPath(text, this.workingDirectory);
  }

  /**
   * 断言 assert allowed 相关数据。
   *
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  assertAllowed(options = {}) {
    if (options.requiresWriteGate && !this.allowWrites) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        "fs write operation blocked by configuration",
        {
          reason: "fs_write_blocked",
          method: options.method,
          path: options.path
        }
      );
    }

    if (this.sandboxPolicy) {
      const sandbox = this.sandboxPolicy.checkPath(options.path, options.accessType);

      if (sandbox.decision !== SANDBOX_DECISIONS.ALLOW) {
        throw createAppServerProtocolError(
          APP_SERVER_ERROR_CODES.INVALID_PARAMS,
          `sandbox blocked: ${sandbox.reason}`,
          {
            reason: "sandbox_denied",
            method: options.method,
            path: options.path,
            sandbox
          }
        );
      }
    }

    if (this.approvalGate && options.requiresWriteGate) {
      const capability = createFilesystemWriteCapabilityRequest({
        method: options.method,
        path: options.path
      });
      const approval = this.approvalGate.check(capabilityRequestToApprovalRequest(capability));

      if (approval.decision !== APPROVAL_DECISIONS.ALLOW) {
        const serverRequest = approval.decision === APPROVAL_DECISIONS.PROMPT && this.serverRequestStore
          ? this.serverRequestStore.create(createFileChangeApprovalServerRequest({
              approval,
              path: options.path,
              reason: approval.approvalRequest?.description ?? `Filesystem write operation: ${options.method}`
            }))
          : null;

        throw createAppServerProtocolError(
          APP_SERVER_ERROR_CODES.INVALID_PARAMS,
          approval.decision === APPROVAL_DECISIONS.PROMPT
            ? "approval required before filesystem write"
            : "filesystem write forbidden by approval policy",
          {
            reason: approval.decision === APPROVAL_DECISIONS.PROMPT
              ? "approval_required"
              : "approval_forbidden",
            method: options.method,
            path: options.path,
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
  }
}

/**
 * 创建 create app server filesystem runtime 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createAppServerFilesystemRuntime(options = {}) {
  return new AppServerFilesystemRuntime(options);
}

/**
 * 处理 require fs param 相关逻辑。
 *
 * @param {unknown} params - params 参数。
 * @param {unknown} name - name 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function requireFsParam(params, name) {
  const value = params?.[name];

  if (value == null || value === "") {
    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_PARAMS,
      `Missing required param: ${name}`
    );
  }

  return value;
}
