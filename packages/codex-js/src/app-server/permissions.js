/**
 * 中文模块说明：src/app-server/permissions.js
 *
 * 面向 UI 或守护进程的 JSONL/RPC app-server 协议层。
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export const PERMISSION_GRANT_SCOPES = Object.freeze({
  TURN: "turn",
  SESSION: "session"
});

/**
 * 归一化 normalize request permission profile 相关数据。
 *
 * @param {unknown} profile - profile 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeRequestPermissionProfile(profile = {}) {
  return {
    network: normalizeNetworkPermissions(profile.network ?? null),
    fileSystem: normalizeFileSystemPermissions(
      profile.fileSystem ?? profile.file_system ?? null
    )
  };
}

/**
 * 归一化 normalize granted permission profile 相关数据。
 *
 * @param {unknown} profile - profile 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeGrantedPermissionProfile(profile = {}) {
  const normalized = normalizeRequestPermissionProfile(profile);
  const granted = {};

  if (normalized.network) {
    granted.network = normalized.network;
  }

  if (normalized.fileSystem) {
    granted.fileSystem = normalized.fileSystem;
  }

  return granted;
}

/**
 * 归一化 normalize permission grant scope 相关数据。
 *
 * @param {unknown} scope - scope 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizePermissionGrantScope(scope) {
  const value = String(scope ?? PERMISSION_GRANT_SCOPES.TURN);

  return value === PERMISSION_GRANT_SCOPES.SESSION
    ? PERMISSION_GRANT_SCOPES.SESSION
    : PERMISSION_GRANT_SCOPES.TURN;
}

/**
 * 创建 create permissions approval params 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createPermissionsApprovalParams(options = {}) {
  const cwd = normalizePermissionPath(options.cwd ?? process.cwd());

  return {
    threadId: String(options.threadId ?? "standalone"),
    turnId: String(options.turnId ?? "standalone"),
    itemId: String(options.itemId ?? options.callId ?? randomUUID()),
    environmentId: options.environmentId ?? options.environment_id ?? null,
    startedAtMs: options.startedAtMs ?? Date.now(),
    cwd,
    reason: options.reason == null ? null : String(options.reason),
    permissions: normalizeRequestPermissionProfile(options.permissions ?? {})
  };
}

/**
 * 创建 create permission grant 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createPermissionGrant(options = {}) {
  const requested = normalizeRequestPermissionProfile(options.requested ?? {});
  const granted = intersectPermissionProfiles(
    requested,
    normalizeGrantedPermissionProfile(options.granted ?? options.permissions ?? {}),
    {
      cwd: options.cwd
    }
  );
  const scope = normalizePermissionGrantScope(options.scope);
  const strictAutoReview = Boolean(options.strictAutoReview ?? options.strict_auto_review ?? false);

  return {
    id: String(options.id ?? randomUUID()),
    threadId: options.threadId == null ? null : String(options.threadId),
    turnId: options.turnId == null ? null : String(options.turnId),
    itemId: options.itemId == null ? null : String(options.itemId),
    environmentId: options.environmentId ?? null,
    cwd: normalizePermissionPath(options.cwd ?? process.cwd()),
    reason: options.reason == null ? null : String(options.reason),
    requested,
    permissions: granted,
    scope,
    strictAutoReview: strictAutoReview && scope === PERMISSION_GRANT_SCOPES.TURN,
    grantedAtMs: options.grantedAtMs ?? Date.now()
  };
}

/**
 * 定义 PermissionGrantStore 类，封装当前模块的状态和行为。
 */
export class PermissionGrantStore {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.grants = [];
    this.idFactory = options.idFactory ?? randomUUID;
  }

  /**
   * 处理 add 相关逻辑。
   *
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  add(options = {}) {
    const grant = createPermissionGrant({
      ...options,
      id: options.id ?? this.idFactory()
    });

    if (!permissionProfileIsEmpty(grant.permissions)) {
      this.grants.push(grant);
    }

    return grant;
  }

  /**
   * 列出 list 相关数据。
   *
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  list(options = {}) {
    const threadId = options.threadId == null ? null : String(options.threadId);
    const turnId = options.turnId == null ? null : String(options.turnId);
    const scope = options.scope == null ? null : normalizePermissionGrantScope(options.scope);

    return this.grants.filter((grant) => {
      if (threadId && grant.threadId !== threadId) {
        return false;
      }

      if (turnId && grant.scope === PERMISSION_GRANT_SCOPES.TURN && grant.turnId !== turnId) {
        return false;
      }

      if (scope && grant.scope !== scope) {
        return false;
      }

      return true;
    });
  }

  /**
   * 处理 clear turn 相关逻辑。
   *
   * @param {unknown} threadId - threadId 参数。
   * @param {unknown} turnId - turnId 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  clearTurn(threadId, turnId) {
    const before = this.grants.length;
    this.grants = this.grants.filter((grant) => !(
      grant.scope === PERMISSION_GRANT_SCOPES.TURN &&
      grant.threadId === String(threadId) &&
      grant.turnId === String(turnId)
    ));

    return before - this.grants.length;
  }
}

/**
 * 创建 create permissions response from client result 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createPermissionsResponseFromClientResult(options = {}) {
  const requested = normalizeRequestPermissionProfile(options.requested ?? {});
  const response = options.response ?? {};
  const result = response.result ?? response;
  const scope = normalizePermissionGrantScope(result.scope);
  const strictAutoReview = Boolean(result.strictAutoReview ?? result.strict_auto_review ?? false);

  if (strictAutoReview && scope === PERMISSION_GRANT_SCOPES.SESSION) {
    return {
      permissions: {},
      scope: PERMISSION_GRANT_SCOPES.TURN,
      strictAutoReview: false,
      deniedReason: "strict_auto_review_session_not_supported"
    };
  }

  return {
    permissions: intersectPermissionProfiles(
      requested,
      normalizeGrantedPermissionProfile(result.permissions ?? {}),
      {
        cwd: options.cwd
      }
    ),
    scope,
    strictAutoReview
  };
}

/**
 * 处理 intersect permission profiles 相关逻辑。
 *
 * @param {unknown} requested - requested 参数。
 * @param {unknown} granted - granted 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function intersectPermissionProfiles(requested = {}, granted = {}, options = {}) {
  const normalizedRequested = normalizeRequestPermissionProfile(requested);
  const normalizedGranted = normalizeGrantedPermissionProfile(granted);
  const result = {};

  if (
    normalizedRequested.network?.enabled === true &&
    normalizedGranted.network?.enabled === true
  ) {
    result.network = {
      enabled: true
    };
  }

  const fileSystem = intersectFileSystemPermissions(
    normalizedRequested.fileSystem,
    normalizedGranted.fileSystem,
    options
  );

  if (fileSystem) {
    result.fileSystem = fileSystem;
  }

  return result;
}

/**
 * 处理 permission profile is empty 相关逻辑。
 *
 * @param {unknown} profile - profile 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function permissionProfileIsEmpty(profile = {}) {
  const normalized = normalizeGrantedPermissionProfile(profile);
  return !normalized.network && !normalized.fileSystem;
}

/**
 * 归一化 normalize network permissions 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeNetworkPermissions(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (value.enabled !== true) {
    return null;
  }

  return {
    enabled: true
  };
}

/**
 * 归一化 normalize file system permissions 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeFileSystemPermissions(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const read = normalizePathList(value.read);
  const write = normalizePathList(value.write);
  const entries = normalizeFileSystemEntries(value.entries);
  const result = {};

  if (read.length > 0) {
    result.read = read;
  }

  if (write.length > 0) {
    result.write = write;
  }

  if (value.globScanMaxDepth != null || value.glob_scan_max_depth != null) {
    const depth = Number(value.globScanMaxDepth ?? value.glob_scan_max_depth);

    if (Number.isSafeInteger(depth) && depth >= 0) {
      result.globScanMaxDepth = depth;
    }
  }

  if (entries.length > 0) {
    result.entries = entries;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * 归一化 normalize file system entries 相关数据。
 *
 * @param {unknown} entries - entries 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeFileSystemEntries(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      path: normalizeFileSystemEntryPath(entry.path),
      access: String(entry.access ?? "read")
    }))
    .filter((entry) => entry.path != null);
}

/**
 * 归一化 normalize file system entry path 相关数据。
 *
 * @param {unknown} path - path 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeFileSystemEntryPath(path) {
  if (typeof path === "string") {
    return normalizePermissionPath(path);
  }

  if (path && typeof path === "object") {
    return {
      ...path,
      path: path.path == null ? undefined : normalizePermissionPath(path.path)
    };
  }

  return null;
}

/**
 * 归一化 normalize path list 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizePathList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value
    .filter((entry) => entry != null && entry !== "")
    .map((entry) => normalizePermissionPath(entry)))];
}

/**
 * 处理 intersect file system permissions 相关逻辑。
 *
 * @param {unknown} requested - requested 参数。
 * @param {unknown} granted - granted 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function intersectFileSystemPermissions(requested, granted, options = {}) {
  if (!requested || !granted) {
    return null;
  }

  const read = intersectPathLists(requested.read, granted.read, options);
  const write = intersectPathLists(requested.write, granted.write, options);
  const entries = intersectEntries(requested.entries, granted.entries, options);
  const result = {};

  if (read.length > 0) {
    result.read = read;
  }

  if (write.length > 0) {
    result.write = write;
  }

  if (requested.globScanMaxDepth != null && granted.globScanMaxDepth != null) {
    result.globScanMaxDepth = Math.min(requested.globScanMaxDepth, granted.globScanMaxDepth);
  }

  if (entries.length > 0) {
    result.entries = entries;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * 处理 intersect path lists 相关逻辑。
 *
 * @param {unknown} requested - requested 参数。
 * @param {unknown} granted - granted 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function intersectPathLists(requested = [], granted = [], options = {}) {
  const requestedSet = new Set((requested ?? []).map((entry) => normalizeComparablePath(entry, options)));

  return (granted ?? [])
    .filter((entry) => requestedSet.has(normalizeComparablePath(entry, options)));
}

/**
 * 处理 intersect entries 相关逻辑。
 *
 * @param {unknown} requested - requested 参数。
 * @param {unknown} granted - granted 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function intersectEntries(requested = [], granted = [], options = {}) {
  const requestedSet = new Set((requested ?? []).map((entry) => JSON.stringify({
    path: normalizeComparableEntryPath(entry.path, options),
    access: entry.access
  })));

  return (granted ?? [])
    .filter((entry) => requestedSet.has(JSON.stringify({
      path: normalizeComparableEntryPath(entry.path, options),
      access: entry.access
    })));
}

/**
 * 归一化 normalize comparable entry path 相关数据。
 *
 * @param {unknown} path - path 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeComparableEntryPath(path, options = {}) {
  if (typeof path === "string") {
    return normalizeComparablePath(path, options);
  }

  if (path && typeof path === "object") {
    return {
      ...path,
      path: path.path == null ? null : normalizeComparablePath(path.path, options)
    };
  }

  return path;
}

/**
 * 归一化 normalize comparable path 相关数据。
 *
 * @param {unknown} path - path 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeComparablePath(path, options = {}) {
  const value = normalizePermissionPath(path);
  const cwd = options.cwd ? normalizePermissionPath(options.cwd) : null;

  if (cwd && !isAbsoluteLikePath(value)) {
    return resolve(cwd, value);
  }

  return value;
}

/**
 * 归一化 normalize permission path 相关数据。
 *
 * @param {unknown} path - path 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizePermissionPath(path) {
  return String(path ?? "").replace(/\\/g, "/");
}

/**
 * 判断是否为 is absolute like path 相关数据。
 *
 * @param {unknown} path - path 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function isAbsoluteLikePath(path) {
  return /^[A-Za-z]:\//.test(path) || path.startsWith("/");
}
