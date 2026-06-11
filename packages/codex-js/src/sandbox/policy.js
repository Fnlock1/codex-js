/**
 * 中文模块说明：src/sandbox/policy.js
 *
 * 文件系统、命令和网络访问的 sandbox 策略。
 */
import path from "node:path";
import {
  APPROVAL_POLICIES,
  SANDBOX_MODES
} from "../protocol/index.js";

export const SANDBOX_ACCESS_TYPES = Object.freeze({
  READ: "read",
  WRITE: "write",
  EXEC: "exec",
  NETWORK: "network"
});

export const SANDBOX_DECISIONS = Object.freeze({
  ALLOW: "allow",
  DENY: "deny"
});

/**
 * 定义 SandboxPolicy 类，封装当前模块的状态和行为。
 */
export class SandboxPolicy {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.mode = options.mode ?? options.sandboxMode ?? SANDBOX_MODES.READ_ONLY;
    this.workingDirectory = normalizeSandboxPath(options.workingDirectory ?? process.cwd());
    this.readRoots = normalizeSandboxRoots(options.readRoots ?? [this.workingDirectory], this.workingDirectory);
    this.writeRoots = normalizeSandboxRoots(
      options.writeRoots ?? defaultWriteRoots(this.mode, this.workingDirectory),
      this.workingDirectory
    );
    this.networkAllowed = options.networkAllowed ?? this.mode === SANDBOX_MODES.DANGER_FULL_ACCESS;
    this.execAllowed = options.execAllowed ?? this.mode !== SANDBOX_MODES.READ_ONLY;
    this.allowedEnvKeys = normalizeEnvKeySet(options.allowedEnvKeys ?? options.allowed_env_keys ?? []);
    this.blockedEnvKeys = normalizeEnvKeySet(options.blockedEnvKeys ?? options.blocked_env_keys ?? [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GITHUB_TOKEN",
      "NPM_TOKEN"
    ]);
  }

  /**
   * 处理 check read 相关逻辑。
   *
   * @param {unknown} pathToCheck - pathToCheck 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  checkRead(pathToCheck) {
    return this.checkPath(pathToCheck, SANDBOX_ACCESS_TYPES.READ);
  }

  /**
   * 处理 check write 相关逻辑。
   *
   * @param {unknown} pathToCheck - pathToCheck 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  checkWrite(pathToCheck) {
    return this.checkPath(pathToCheck, SANDBOX_ACCESS_TYPES.WRITE);
  }

  /**
   * 处理 check path 相关逻辑。
   *
   * @param {unknown} pathToCheck - pathToCheck 参数。
   * @param {unknown} accessType - accessType 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  checkPath(pathToCheck, accessType = SANDBOX_ACCESS_TYPES.READ) {
    const absolutePath = normalizeSandboxPath(pathToCheck, this.workingDirectory);

    if (this.mode === SANDBOX_MODES.DANGER_FULL_ACCESS) {
      return createSandboxDecision({
        decision: SANDBOX_DECISIONS.ALLOW,
        accessType,
        path: absolutePath,
        policy: this
      });
    }

    const roots = accessType === SANDBOX_ACCESS_TYPES.WRITE
      ? this.writeRoots
      : this.readRoots;
    const allowed = roots.some((root) => pathIsInsideRoot(absolutePath, root));

    return createSandboxDecision({
      decision: allowed ? SANDBOX_DECISIONS.ALLOW : SANDBOX_DECISIONS.DENY,
      accessType,
      path: absolutePath,
      policy: this,
      reason: allowed ? null : `${accessType} outside sandbox roots`
    });
  }

  /**
   * 处理 check exec 相关逻辑。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  checkExec(request = {}) {
    const cwd = normalizeSandboxPath(request.cwd ?? this.workingDirectory, this.workingDirectory);
    const cwdDecision = this.checkPath(cwd, SANDBOX_ACCESS_TYPES.READ);
    const risk = classifyCommandRisk(request.command ?? request.argv ?? "");
    const envDecision = this.checkEnv(request.env);
    const networkDecision = risk === "network" ? this.checkNetwork() : createSandboxDecision({
      decision: SANDBOX_DECISIONS.ALLOW,
      accessType: SANDBOX_ACCESS_TYPES.NETWORK,
      policy: this
    });
    const allowed = (
      this.execAllowed &&
      cwdDecision.decision === SANDBOX_DECISIONS.ALLOW &&
      envDecision.decision === SANDBOX_DECISIONS.ALLOW &&
      networkDecision.decision === SANDBOX_DECISIONS.ALLOW
    );

    return createSandboxDecision({
      decision: allowed ? SANDBOX_DECISIONS.ALLOW : SANDBOX_DECISIONS.DENY,
      accessType: SANDBOX_ACCESS_TYPES.EXEC,
      path: cwd,
      policy: this,
      reason: allowed
        ? null
        : this.execAllowed
          ? cwdDecision.reason ?? envDecision.reason ?? networkDecision.reason
          : "exec disabled by sandbox",
      metadata: {
        command_risk: risk,
        env: envDecision.metadata,
        network: networkDecision
      }
    });
  }

  /**
   * 处理 check env 相关逻辑。
   *
   * @param {unknown} env - env 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  checkEnv(env = null) {
    if (!env || typeof env !== "object") {
      return createSandboxDecision({
        decision: SANDBOX_DECISIONS.ALLOW,
        accessType: SANDBOX_ACCESS_TYPES.EXEC,
        policy: this,
        metadata: {
          blocked_keys: []
        }
      });
    }

    const keys = Object.keys(env).map(String);
    const blockedKeys = keys.filter((key) => (
      this.blockedEnvKeys.has(key.toUpperCase()) ||
      (
        this.allowedEnvKeys.size > 0 &&
        !this.allowedEnvKeys.has(key.toUpperCase())
      )
    ));

    return createSandboxDecision({
      decision: blockedKeys.length === 0 ? SANDBOX_DECISIONS.ALLOW : SANDBOX_DECISIONS.DENY,
      accessType: SANDBOX_ACCESS_TYPES.EXEC,
      policy: this,
      reason: blockedKeys.length === 0 ? null : `environment keys blocked by sandbox: ${blockedKeys.join(", ")}`,
      metadata: {
        blocked_keys: blockedKeys
      }
    });
  }

  /**
   * 处理 check network 相关逻辑。
   * @returns {unknown} 返回处理后的结果。
   */
  checkNetwork() {
    return createSandboxDecision({
      decision: this.networkAllowed ? SANDBOX_DECISIONS.ALLOW : SANDBOX_DECISIONS.DENY,
      accessType: SANDBOX_ACCESS_TYPES.NETWORK,
      path: null,
      policy: this,
      reason: this.networkAllowed ? null : "network disabled by sandbox"
    });
  }
}

/**
 * 创建 create sandbox policy from profile 相关数据。
 *
 * @param {unknown} profile - profile 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createSandboxPolicyFromProfile(profile = {}, options = {}) {
  const sandboxMode = typeof profile === "string"
    ? profile
    : profile.sandboxMode ?? profile.sandbox_mode ?? options.sandboxMode ?? SANDBOX_MODES.READ_ONLY;

  return new SandboxPolicy({
    mode: sandboxMode,
    workingDirectory: options.workingDirectory,
    readRoots: options.readRoots,
    writeRoots: options.writeRoots,
    networkAllowed: options.networkAllowed,
    execAllowed: options.execAllowed,
    allowedEnvKeys: options.allowedEnvKeys,
    blockedEnvKeys: options.blockedEnvKeys
  });
}

/**
 * 创建 create sandbox decision 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createSandboxDecision(options = {}) {
  return {
    decision: options.decision ?? SANDBOX_DECISIONS.DENY,
    access_type: options.accessType ?? options.access_type ?? SANDBOX_ACCESS_TYPES.READ,
    path: options.path ?? null,
    reason: options.reason ?? null,
    sandbox_mode: options.policy?.mode ?? options.sandboxMode ?? null,
    allowed: (options.decision ?? SANDBOX_DECISIONS.DENY) === SANDBOX_DECISIONS.ALLOW,
    metadata: options.metadata ?? {}
  };
}

/**
 * 断言 assert sandbox allowed 相关数据。
 *
 * @param {unknown} decision - decision 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function assertSandboxAllowed(decision) {
  if (decision.decision !== SANDBOX_DECISIONS.ALLOW) {
    throw createSandboxError(decision.reason ?? "sandbox denied operation", {
      decision
    });
  }

  return decision;
}

/**
 * 定义 SandboxError 类，封装当前模块的状态和行为。
 */
export class SandboxError extends Error {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} message - message 参数。
   * @param {unknown} options - options 参数。
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "SandboxError";
    this.code = options.code ?? "sandbox_denied";
    this.decision = options.decision ?? null;
  }
}

/**
 * 创建 create sandbox error 相关数据。
 *
 * @param {unknown} message - message 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createSandboxError(message, options = {}) {
  return new SandboxError(message, options);
}

/**
 * 归一化 normalize sandbox path 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @param {unknown} base - base 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeSandboxPath(value, base = process.cwd()) {
  const text = String(value ?? "");
  return path.resolve(path.isAbsolute(text) ? text : path.join(base, text));
}

/**
 * 归一化 normalize sandbox roots 相关数据。
 *
 * @param {unknown} roots - roots 参数。
 * @param {unknown} base - base 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeSandboxRoots(roots, base = process.cwd()) {
  return (Array.isArray(roots) ? roots : [roots])
    .filter(Boolean)
    .map((root) => normalizeSandboxPath(root, base));
}

/**
 * 处理 path is inside root 相关逻辑。
 *
 * @param {unknown} candidate - candidate 参数。
 * @param {unknown} root - root 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function pathIsInsideRoot(candidate, root) {
  const normalizedCandidate = normalizeSandboxPath(candidate);
  const normalizedRoot = normalizeSandboxPath(root);
  const relativePath = path.relative(normalizedRoot, normalizedCandidate);

  return (
    relativePath === "" ||
    (
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath)
    )
  );
}

/**
 * 处理 default permission profile for sandbox mode 相关逻辑。
 *
 * @param {unknown} sandboxMode - sandboxMode 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function defaultPermissionProfileForSandboxMode(sandboxMode) {
  switch (sandboxMode) {
    case SANDBOX_MODES.DANGER_FULL_ACCESS:
      return {
        approvalPolicy: APPROVAL_POLICIES.NEVER,
        sandboxMode: SANDBOX_MODES.DANGER_FULL_ACCESS
      };
    case SANDBOX_MODES.WORKSPACE_WRITE:
      return {
        approvalPolicy: APPROVAL_POLICIES.ON_REQUEST,
        sandboxMode: SANDBOX_MODES.WORKSPACE_WRITE
      };
    case SANDBOX_MODES.READ_ONLY:
    default:
      return {
        approvalPolicy: APPROVAL_POLICIES.ON_REQUEST,
        sandboxMode: SANDBOX_MODES.READ_ONLY
      };
  }
}

/**
 * 处理 default write roots 相关逻辑。
 *
 * @param {unknown} mode - mode 参数。
 * @param {unknown} workingDirectory - workingDirectory 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function defaultWriteRoots(mode, workingDirectory) {
  if (mode === SANDBOX_MODES.WORKSPACE_WRITE) {
    return [workingDirectory];
  }

  if (mode === SANDBOX_MODES.DANGER_FULL_ACCESS) {
    return [path.parse(workingDirectory).root];
  }

  return [];
}

/**
 * 处理 classify command risk 相关逻辑。
 *
 * @param {unknown} command - command 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function classifyCommandRisk(command) {
  const text = Array.isArray(command)
    ? command.join(" ")
    : String(command ?? "");
  const normalized = text.trim().toLowerCase();
  const destructivePatterns = [
    /\brm\s+(-[^\s]*r|-[^\s]*f|-[^\s]*rf|-[^\s]*fr)/u,
    /\brmdir\b/u,
    /\bdel\s+/u,
    /\bremove-item\b/u,
    /\bgit\s+reset\s+--hard\b/u,
    /\bgit\s+clean\b/u,
    /\bformat\b/u
  ];
  const networkPatterns = [
    /\bcurl\b/u,
    /\bwget\b/u,
    /\binvoke-webrequest\b/u,
    /\biwr\b/u,
    /\bnpm\s+(install|add)\b/u,
    /\bpnpm\s+(install|add)\b/u,
    /\byarn\s+add\b/u
  ];

  if (destructivePatterns.some((pattern) => pattern.test(normalized))) {
    return "destructive";
  }

  if (networkPatterns.some((pattern) => pattern.test(normalized))) {
    return "network";
  }

  return "normal";
}

/**
 * 归一化 normalize env key set 相关数据。
 *
 * @param {unknown} keys - keys 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeEnvKeySet(keys) {
  return new Set(
    (Array.isArray(keys) ? keys : [keys])
      .filter(Boolean)
      .map((key) => String(key).toUpperCase())
  );
}
