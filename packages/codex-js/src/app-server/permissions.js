import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export const PERMISSION_GRANT_SCOPES = Object.freeze({
  TURN: "turn",
  SESSION: "session"
});

export function normalizeRequestPermissionProfile(profile = {}) {
  return {
    network: normalizeNetworkPermissions(profile.network ?? null),
    fileSystem: normalizeFileSystemPermissions(
      profile.fileSystem ?? profile.file_system ?? null
    )
  };
}

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

export function normalizePermissionGrantScope(scope) {
  const value = String(scope ?? PERMISSION_GRANT_SCOPES.TURN);

  return value === PERMISSION_GRANT_SCOPES.SESSION
    ? PERMISSION_GRANT_SCOPES.SESSION
    : PERMISSION_GRANT_SCOPES.TURN;
}

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

export class PermissionGrantStore {
  constructor(options = {}) {
    this.grants = [];
    this.idFactory = options.idFactory ?? randomUUID;
  }

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

export function permissionProfileIsEmpty(profile = {}) {
  const normalized = normalizeGrantedPermissionProfile(profile);
  return !normalized.network && !normalized.fileSystem;
}

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

function normalizePathList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value
    .filter((entry) => entry != null && entry !== "")
    .map((entry) => normalizePermissionPath(entry)))];
}

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

function intersectPathLists(requested = [], granted = [], options = {}) {
  const requestedSet = new Set((requested ?? []).map((entry) => normalizeComparablePath(entry, options)));

  return (granted ?? [])
    .filter((entry) => requestedSet.has(normalizeComparablePath(entry, options)));
}

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

function normalizeComparablePath(path, options = {}) {
  const value = normalizePermissionPath(path);
  const cwd = options.cwd ? normalizePermissionPath(options.cwd) : null;

  if (cwd && !isAbsoluteLikePath(value)) {
    return resolve(cwd, value);
  }

  return value;
}

function normalizePermissionPath(path) {
  return String(path ?? "").replace(/\\/g, "/");
}

function isAbsoluteLikePath(path) {
  return /^[A-Za-z]:\//.test(path) || path.startsWith("/");
}
