/**
 * 中文模块说明：src/exec/runtime.js
 *
 * 命令执行、PTY 会话、输出事件和执行权限策略。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { createExecToolCallOutput } from "../protocol/index.js";

export const EXEC_RUNTIME_ERRORS = Object.freeze({
  BLOCKED: "blocked",
  SPAWN_ERROR: "spawn_error",
  TIMED_OUT: "timed_out"
});

/**
 * 定义 ExecRuntime 类，封装当前模块的状态和行为。
 */
export class ExecRuntime {
  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} _request - _request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async run(_request) {
    throw new Error("ExecRuntime.run() must be implemented by a subclass.");
  }
}

/**
 * 定义 DryRunExecRuntime 类，封装当前模块的状态和行为。
 */
export class DryRunExecRuntime extends ExecRuntime {
  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async run(request) {
    return createExecResult({
      output: createExecToolCallOutput({
        stdout: `dry-run: ${request.command}`,
        exitCode: 0,
        durationMs: 0
      }),
      executed: false,
      dryRun: true
    });
  }
}

/**
 * 定义 BlockedExecRuntime 类，封装当前模块的状态和行为。
 */
export class BlockedExecRuntime extends ExecRuntime {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    super();
    this.reason = options.reason ?? "not_allowed";
  }

  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async run(request) {
    return blockedExecResult({
      decision: this.reason,
      output: createExecToolCallOutput({
        stderr: `exec blocked: ${this.reason}`,
        exitCode: 1,
        durationMs: 0
      })
    });
  }
}

/**
 * 定义 RealExecRuntime 类，封装当前模块的状态和行为。
 */
export class RealExecRuntime extends ExecRuntime {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    super();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    this.baseEnv = options.baseEnv ?? process.env;
    this.blockedEnvKeys = normalizeEnvKeySet(options.blockedEnvKeys ?? options.blocked_env_keys ?? []);
    this.allowedEnvKeys = normalizeEnvKeySet(options.allowedEnvKeys ?? options.allowed_env_keys ?? []);
  }

  /**
   * 执行当前对象负责的核心流程。
   *
   * 这是异步流程，调用方需要等待 Promise 完成。
   *
   * @param {unknown} request - request 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  async run(request) {
    const normalized = createExecRequest(request);
    const startedAt = Date.now();
    const timeoutMs = normalized.timeout_ms ?? this.defaultTimeoutMs;

    return await new Promise((resolve) => {
      const command = spawnCommandForRequest(normalized);
      const child = spawn(command.file, command.args, {
        cwd: path.resolve(normalized.cwd),
        env: normalizeExecEnv(normalized.env, {
          baseEnv: this.baseEnv,
          blockedEnvKeys: this.blockedEnvKeys,
          allowedEnvKeys: this.allowedEnvKeys
        }),
        windowsHide: true
      });
      const stdoutChunks = [];
      const stderrChunks = [];
      let timedOut = false;
      let settled = false;
      const timeout = timeoutMs == null
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, timeoutMs);

      child.stdout?.on("data", (chunk) => {
        stdoutChunks.push(Buffer.from(chunk));
      });
      child.stderr?.on("data", (chunk) => {
        stderrChunks.push(Buffer.from(chunk));
      });
      child.on("error", (error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeoutIfNeeded(timeout);
        resolve(createExecResult({
          output: createExecToolCallOutput({
            stderr: error.message,
            exitCode: 1,
            durationMs: Date.now() - startedAt,
            timedOut
          }),
          executed: false,
          dryRun: false,
          error: EXEC_RUNTIME_ERRORS.SPAWN_ERROR
        }));
      });
      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeoutIfNeeded(timeout);
        const stdout = decodeAndClampOutput(stdoutChunks, this.maxOutputBytes);
        const stderr = decodeAndClampOutput(stderrChunks, this.maxOutputBytes);
        const exitCode = timedOut ? 124 : code ?? signalToExitCode(signal);

        resolve(createExecResult({
          output: createExecToolCallOutput({
            stdout,
            stderr,
            exitCode,
            durationMs: Date.now() - startedAt,
            timedOut
          }),
          executed: true,
          dryRun: false,
          error: timedOut ? EXEC_RUNTIME_ERRORS.TIMED_OUT : null
        }));
      });
    });
  }
}

/**
 * 创建 create exec request 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createExecRequest(options = {}) {
  const argv = normalizeExecArgv(options.argv ?? (
    Array.isArray(options.command) ? options.command : null
  ));
  const request = {
    command: argv ? argv.map(quoteCommandDisplayPart).join(" ") : String(options.command ?? ""),
    cwd: options.cwd ? String(options.cwd) : process.cwd(),
    timeout_ms: options.timeoutMs ?? options.timeout_ms ?? null,
    env: options.env ?? null
  };

  if (argv) {
    request.argv = argv;
  }

  if (options.platform != null) {
    request.platform = options.platform;
  }

  return request;
}

/**
 * 创建 create exec result 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createExecResult(options = {}) {
  return {
    output: options.output ?? createExecToolCallOutput(),
    executed: options.executed ?? false,
    dry_run: options.dryRun ?? options.dry_run ?? false,
    error: options.error ?? null
  };
}

/**
 * 处理 blocked exec result 相关逻辑。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function blockedExecResult({ decision, output }) {
  return createExecResult({
    output,
    executed: false,
    dryRun: true,
    error: `blocked: ${decision}`
  });
}

/**
 * 处理 shell command for platform 相关逻辑。
 *
 * @param {unknown} command - command 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function shellCommandForPlatform(command, options = {}) {
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    return {
      file: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        String(command ?? "")
      ]
    };
  }

  return {
    file: "sh",
    args: ["-c", String(command ?? "")]
  };
}

/**
 * 处理 spawn command for request 相关逻辑。
 *
 * @param {unknown} request - request 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function spawnCommandForRequest(request) {
  if (Array.isArray(request.argv) && request.argv.length > 0) {
    return {
      file: request.argv[0],
      args: request.argv.slice(1)
    };
  }

  return shellCommandForPlatform(request.command, {
    platform: request.platform
  });
}

/**
 * 归一化 normalize exec env 相关数据。
 *
 * @param {unknown} env - env 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeExecEnv(env, options = {}) {
  const blockedEnvKeys = normalizeEnvKeySet(options.blockedEnvKeys ?? options.blocked_env_keys ?? []);
  const allowedEnvKeys = normalizeEnvKeySet(options.allowedEnvKeys ?? options.allowed_env_keys ?? []);
  const baseEnv = options.baseEnv ?? process.env;
  const overrides = Object.fromEntries(
    Object.entries(env ?? {}).map(([key, value]) => [key, String(value)])
  );
  const sanitizedBase = Object.fromEntries(
    Object.entries(baseEnv)
      .filter(([key]) => !blockedEnvKeys.has(String(key).toUpperCase()))
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (!envKeyAllowed(key, {
        blockedEnvKeys,
        allowedEnvKeys
      })) {
      continue;
    }

    sanitizedBase[key] = value;
  }

  return sanitizedBase;
}

/**
 * 归一化 normalize exec argv 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeExecArgv(value) {
  if (value == null) {
    return null;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Exec argv must be a non-empty string array.");
  }

  return value.map((part) => String(part));
}

/**
 * 解码 decode and clamp output 相关数据。
 *
 * @param {unknown} chunks - chunks 参数。
 * @param {unknown} maxBytes - maxBytes 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function decodeAndClampOutput(chunks, maxBytes = 1_000_000) {
  const buffer = Buffer.concat(chunks);

  if (buffer.length <= maxBytes) {
    return buffer.toString("utf8");
  }

  return buffer.subarray(0, maxBytes).toString("utf8");
}

/**
 * 处理 signal to exit code 相关逻辑。
 *
 * @param {unknown} signal - signal 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function signalToExitCode(signal) {
  return signal ? 1 : 0;
}

/**
 * 处理 clear timeout if needed 相关逻辑。
 *
 * @param {unknown} timeout - timeout 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function clearTimeoutIfNeeded(timeout) {
  if (timeout) {
    clearTimeout(timeout);
  }
}

/**
 * 处理 quote command display part 相关逻辑。
 *
 * @param {unknown} part - part 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function quoteCommandDisplayPart(part) {
  const text = String(part);

  if (!text || /\s/.test(text)) {
    return `"${text.replaceAll("\"", "\\\"")}"`;
  }

  return text;
}

/**
 * 归一化 normalize env key set 相关数据。
 *
 * @param {unknown} keys - keys 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeEnvKeySet(keys) {
  if (keys instanceof Set) {
    return new Set(
      Array.from(keys)
        .filter(Boolean)
        .map((key) => String(key).toUpperCase())
    );
  }

  return new Set(
    (Array.isArray(keys) ? keys : [keys])
      .filter(Boolean)
      .map((key) => String(key).toUpperCase())
  );
}

/**
 * 处理 env key allowed 相关逻辑。
 *
 * @param {unknown} key - key 参数。
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function envKeyAllowed(key, options = {}) {
  const normalized = String(key).toUpperCase();

  if (options.blockedEnvKeys?.has(normalized)) {
    return false;
  }

  if (options.allowedEnvKeys?.size > 0 && !options.allowedEnvKeys.has(normalized)) {
    return false;
  }

  return true;
}
