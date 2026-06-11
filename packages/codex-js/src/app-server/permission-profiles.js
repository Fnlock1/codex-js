/**
 * 中文模块说明：src/app-server/permission-profiles.js
 *
 * 面向 UI 或守护进程的 JSONL/RPC app-server 协议层。
 */
import {
  APPROVAL_POLICIES,
  PERMISSION_PROFILES,
  SANDBOX_MODES
} from "../protocol/permissions.js";

export const BUILTIN_PERMISSION_PROFILE_IDS = Object.freeze({
  READ_ONLY: "read-only",
  WORKSPACE_WRITE: "workspace-write",
  DANGER_FULL_ACCESS: "danger-full-access"
});

/**
 * 列出 list permission profiles 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function listPermissionProfiles(options = {}) {
  const all = createBuiltinPermissionProfileSummaries();
  const limit = clampLimit(options.limit ?? 50);
  const offset = decodeCursor(options.cursor);
  const data = all.slice(offset, offset + limit);
  const nextOffset = offset + data.length;

  return {
    data,
    nextCursor: nextOffset < all.length ? encodeCursor(nextOffset) : null
  };
}

/**
 * 创建 create builtin permission profile summaries 相关数据。
 * @returns {unknown} 返回处理后的结果。
 */
export function createBuiltinPermissionProfileSummaries() {
  return [
    createPermissionProfileSummary({
      id: BUILTIN_PERMISSION_PROFILE_IDS.READ_ONLY,
      description: "Read files and require approval before commands or writes.",
      profile: PERMISSION_PROFILES.READ_ONLY
    }),
    createPermissionProfileSummary({
      id: BUILTIN_PERMISSION_PROFILE_IDS.WORKSPACE_WRITE,
      description: "Allow writes inside the workspace and require approval for risky actions.",
      profile: PERMISSION_PROFILES.WORKSPACE_WRITE
    }),
    createPermissionProfileSummary({
      id: BUILTIN_PERMISSION_PROFILE_IDS.DANGER_FULL_ACCESS,
      description: "Disable sandboxing and approval gates for trusted local use.",
      profile: PERMISSION_PROFILES.DANGER_FULL_ACCESS
    })
  ];
}

/**
 * 创建 create permission profile summary 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createPermissionProfileSummary(options = {}) {
  const profile = options.profile ?? {};

  return {
    id: String(options.id ?? ""),
    description: options.description == null ? null : String(options.description),
    approvalPolicy: profile.approvalPolicy ?? profile.approval_policy ?? APPROVAL_POLICIES.ON_REQUEST,
    sandboxMode: profile.sandboxMode ?? profile.sandbox_mode ?? SANDBOX_MODES.READ_ONLY,
    builtIn: options.builtIn ?? true
  };
}

/**
 * 处理 clamp limit 相关逻辑。
 *
 * @param {unknown} limit - limit 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function clampLimit(limit) {
  const number = Number(limit);

  if (!Number.isFinite(number) || number <= 0) {
    return 50;
  }

  return Math.min(Math.floor(number), 200);
}

/**
 * 编码 encode cursor 相关数据。
 *
 * @param {unknown} offset - offset 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({
    offset
  })).toString("base64url");
}

/**
 * 解码 decode cursor 相关数据。
 *
 * @param {unknown} cursor - cursor 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function decodeCursor(cursor) {
  if (!cursor) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    const offset = Number(parsed.offset);

    return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}
