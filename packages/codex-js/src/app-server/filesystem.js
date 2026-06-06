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
  APPROVAL_ACTIONS,
  APPROVAL_DECISIONS,
  APPROVAL_RESOURCE_TYPES
} from "../approval/policy.js";
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

export class AppServerFilesystemRuntime {
  constructor(options = {}) {
    this.workingDirectory = options.workingDirectory ?? process.cwd();
    this.allowWrites = Boolean(options.allowWrites ?? false);
    this.sandboxPolicy = options.sandboxPolicy ?? null;
    this.approvalGate = options.approvalGate ?? null;
    this.serverRequestStore = options.serverRequestStore ?? null;
    this.onChanged = options.onChanged ?? null;
    this.watchers = new Map();
  }

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

  closeAllWatchers() {
    for (const entry of this.watchers.values()) {
      entry.watcher.close();
    }

    this.watchers.clear();
  }

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
      const approval = this.approvalGate.check({
        resourceType: APPROVAL_RESOURCE_TYPES.TOOL,
        action: APPROVAL_ACTIONS.WRITE,
        subject: `${options.method}:${options.path}`,
        description: `Filesystem write operation: ${options.method}`,
        metadata: {
          method: options.method,
          path: options.path
        }
      });

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

export function createAppServerFilesystemRuntime(options = {}) {
  return new AppServerFilesystemRuntime(options);
}

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
