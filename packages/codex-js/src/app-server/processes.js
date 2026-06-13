/**
 * 中文模块说明：src/app-server/processes.js
 *
 * 面向 UI 或守护进程的 JSONL/RPC app-server 协议层。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import {
  EXEC_RUNTIME_ERRORS,
  normalizeExecEnv
} from "../exec/runtime.js";
import {
  APP_SERVER_ERROR_CODES,
  createAppServerProtocolError
} from "./protocol.js";

export const APP_SERVER_PROCESS_METHODS = Object.freeze({
  SPAWN: "process/spawn",
  WRITE_STDIN: "process/writeStdin",
  RESIZE_PTY: "process/resizePty",
  KILL: "process/kill"
});

export const APP_SERVER_PROCESS_NOTIFICATIONS = Object.freeze({
  OUTPUT_DELTA: "process/outputDelta",
  EXITED: "process/exited"
});

export const PROCESS_STATUSES = Object.freeze({
  RUNNING: "running",
  EXITED: "exited",
  FAILED: "failed",
  KILLED: "killed"
});

/**
 * 定义 BlockedProcessRuntime 类，封装当前模块的状态和行为。
 */
export class BlockedProcessRuntime {
  /**
   * 处理 spawn 相关逻辑。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  spawn(params = {}) {
    const request = normalizeProcessSpawnParams(params);

    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_PARAMS,
      "process/spawn is blocked by configuration",
      {
        reason: EXEC_RUNTIME_ERRORS.BLOCKED,
        processHandle: request.processHandle
      }
    );
  }

  /**
   * 写入 write stdin 相关数据。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  writeStdin(params = {}) {
    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_PARAMS,
      "process/writeStdin is blocked by configuration",
      {
        reason: EXEC_RUNTIME_ERRORS.BLOCKED,
        processHandle: params.processHandle ?? params.process_handle ?? null
      }
    );
  }

  /**
   * 处理 resize pty 相关逻辑。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  resizePty(params = {}) {
    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_PARAMS,
      "process/resizePty is blocked by configuration",
      {
        reason: EXEC_RUNTIME_ERRORS.BLOCKED,
        processHandle: params.processHandle ?? params.process_handle ?? null
      }
    );
  }

  /**
   * 处理 kill 相关逻辑。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  kill(params = {}) {
    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_PARAMS,
      "process/kill is blocked by configuration",
      {
        reason: EXEC_RUNTIME_ERRORS.BLOCKED,
        processHandle: params.processHandle ?? params.process_handle ?? null
      }
    );
  }
}

/**
 * 定义 RealProcessRuntime 类，封装当前模块的状态和行为。
 */
export class RealProcessRuntime {
  /**
   * 初始化实例依赖和运行状态。
   *
   * @param {unknown} options - options 参数。
   */
  constructor(options = {}) {
    this.sessions = new Map();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.defaultOutputBytesCap = options.defaultOutputBytesCap ?? 1_000_000;
    this.onOutputDelta = options.onOutputDelta ?? null;
    this.onExited = options.onExited ?? null;
  }

  /**
   * 处理 spawn 相关逻辑。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  spawn(params = {}) {
    const request = normalizeProcessSpawnParams(params, {
      defaultTimeoutMs: this.defaultTimeoutMs,
      defaultOutputBytesCap: this.defaultOutputBytesCap
    });

    if (this.activeSession(request.processHandle)) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `active process already exists: ${request.processHandle}`,
        {
          reason: "duplicate_process_handle",
          processHandle: request.processHandle
        }
      );
    }

    const session = {
      processHandle: request.processHandle,
      command: request.command,
      cwd: request.cwd,
      request,
      status: PROCESS_STATUSES.RUNNING,
      child: null,
      stdinClosed: !request.streamStdin,
      stdoutChunks: [],
      stderrChunks: [],
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutCapReached: false,
      stderrCapReached: false,
      timeout: null,
      timedOut: false,
      terminalSize: request.size ?? null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null
    };

    this.sessions.set(request.processHandle, session);

    try {
      const child = spawn(request.command[0], request.command.slice(1), {
        cwd: request.cwd,
        env: normalizeProcessEnv(request.env),
        windowsHide: true,
        stdio: [
          request.streamStdin ? "pipe" : "ignore",
          "pipe",
          "pipe"
        ]
      });

      session.child = child;

      child.stdout?.on("data", (chunk) => {
        this.recordOutput(session, "stdout", Buffer.from(chunk));
      });
      child.stderr?.on("data", (chunk) => {
        this.recordOutput(session, "stderr", Buffer.from(chunk));
      });
      child.on("error", (error) => {
        session.status = PROCESS_STATUSES.FAILED;
        session.exitCode = 1;
        session.stderrChunks.push(Buffer.from(error.message));
        session.exitedAt = new Date().toISOString();
        clearTimeoutIfNeeded(session.timeout);
        this.emitExited(session);
      });
      child.on("close", (code, signal) => {
        clearTimeoutIfNeeded(session.timeout);
        session.exitCode = session.timedOut ? 124 : code ?? (signal ? 137 : 0);
        session.status = session.exitCode === 0
          ? PROCESS_STATUSES.EXITED
          : PROCESS_STATUSES.FAILED;
        session.exitedAt = new Date().toISOString();
        this.emitExited(session);
      });

      if (request.timeoutMs != null) {
        session.timeout = setTimeout(() => {
          session.timedOut = true;
          child.kill("SIGTERM");
        }, request.timeoutMs);
      }
    } catch (error) {
      session.status = PROCESS_STATUSES.FAILED;
      session.exitCode = 1;
      session.stderrChunks.push(Buffer.from(error.message));
      session.exitedAt = new Date().toISOString();
      this.emitExited(session);
    }

    return {};
  }

  /**
   * 写入 write stdin 相关数据。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  writeStdin(params = {}) {
    const processHandle = normalizeProcessHandle(params.processHandle ?? params.process_handle);
    const session = this.requireSession(processHandle);
    const deltaBase64 = params.deltaBase64 ?? params.delta_base64 ?? null;
    const closeStdin = Boolean(params.closeStdin ?? params.close_stdin ?? false);

    if (!deltaBase64 && !closeStdin) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        "process/writeStdin requires deltaBase64 or closeStdin",
        {
          reason: "missing_stdin_delta",
          processHandle
        }
      );
    }

    if (!session.request.streamStdin) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        "stdin streaming is not enabled for this process",
        {
          reason: "stdin_not_enabled",
          processHandle
        }
      );
    }

    if (session.stdinClosed || !session.child?.stdin?.writable) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        "stdin is already closed",
        {
          reason: "stdin_closed",
          processHandle
        }
      );
    }

    if (deltaBase64) {
      session.child.stdin.write(Buffer.from(String(deltaBase64), "base64"));
    }

    if (closeStdin) {
      session.stdinClosed = true;
      session.child.stdin.end();
    }

    return {};
  }

  /**
   * 处理 resize pty 相关逻辑。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  resizePty(params = {}) {
    const processHandle = normalizeProcessHandle(params.processHandle ?? params.process_handle);
    const session = this.requireSession(processHandle);

    session.terminalSize = normalizeProcessTerminalSize(requireProcessParam(params, "size"));
    return {};
  }

  /**
   * 处理 kill 相关逻辑。
   *
   * @param {unknown} params - params 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  kill(params = {}) {
    const processHandle = normalizeProcessHandle(params.processHandle ?? params.process_handle);
    const session = this.requireSession(processHandle);

    session.status = PROCESS_STATUSES.KILLED;
    session.child?.kill("SIGTERM");
    return {};
  }

  /**
   * 获取 get 相关数据。
   *
   * @param {unknown} processHandle - processHandle 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  get(processHandle) {
    return this.sessions.get(String(processHandle)) ?? null;
  }

  /**
   * 处理 active session 相关逻辑。
   *
   * @param {unknown} processHandle - processHandle 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  activeSession(processHandle) {
    const session = this.get(processHandle);

    return session?.status === PROCESS_STATUSES.RUNNING ? session : null;
  }

  /**
   * 处理 require session 相关逻辑。
   *
   * @param {unknown} processHandle - processHandle 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  requireSession(processHandle) {
    const session = this.get(processHandle);

    if (!session) {
      throw createAppServerProtocolError(
        APP_SERVER_ERROR_CODES.INVALID_PARAMS,
        `process not found: ${processHandle}`,
        {
          reason: "process_not_found",
          processHandle
        }
      );
    }

    return session;
  }

  /**
   * 处理 record output 相关逻辑。
   *
   * @param {unknown} session - session 参数。
   * @param {unknown} stream - stream 参数。
   * @param {unknown} chunk - chunk 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  recordOutput(session, stream, chunk) {
    const cap = session.request.outputBytesCap;
    const capped = clampBufferForStream(session, stream, chunk, cap);
    const capReachedKey = stream === "stdout" ? "stdoutCapReached" : "stderrCapReached";

    if (capped.buffer.length > 0) {
      if (session.request.streamStdoutStderr) {
        this.emitOutputDelta(session, stream, capped.buffer, {
          capReached: capped.capReached
        });
      } else {
        const chunks = stream === "stdout" ? session.stdoutChunks : session.stderrChunks;
        chunks.push(capped.buffer);
      }
    }

    if (capped.capReached) {
      session[capReachedKey] = true;
    }
  }

  /**
   * 发送 emit output delta 相关数据。
   *
   * @param {unknown} session - session 参数。
   * @param {unknown} stream - stream 参数。
   * @param {unknown} chunk - chunk 参数。
   * @param {unknown} options - options 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  emitOutputDelta(session, stream, chunk, options = {}) {
    if (!this.onOutputDelta) {
      return;
    }

    this.onOutputDelta({
      processHandle: session.processHandle,
      stream,
      deltaBase64: Buffer.from(chunk).toString("base64"),
      capReached: Boolean(options.capReached ?? false)
    });
  }

  /**
   * 发送 emit exited 相关数据。
   *
   * @param {unknown} session - session 参数。
   * @returns {unknown} 返回处理后的结果。
   */
  emitExited(session) {
    if (!this.onExited) {
      return;
    }

    this.onExited(createProcessExitedNotificationParams(session));
  }
}

/**
 * 创建 create process output delta notification params 相关数据。
 *
 * @param {unknown} options - options 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createProcessOutputDeltaNotificationParams(options = {}) {
  return {
    processHandle: String(options.processHandle ?? ""),
    stream: options.stream === "stderr" ? "stderr" : "stdout",
    deltaBase64: String(options.deltaBase64 ?? ""),
    capReached: Boolean(options.capReached ?? false)
  };
}

/**
 * 创建 create process exited notification params 相关数据。
 *
 * @param {unknown} session - session 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function createProcessExitedNotificationParams(session = {}) {
  const request = session.request ?? {};
  const streamed = Boolean(request.streamStdoutStderr);

  return {
    processHandle: String(session.processHandle ?? ""),
    exitCode: Number.isInteger(session.exitCode) ? session.exitCode : 1,
    stdout: streamed ? "" : Buffer.concat(session.stdoutChunks ?? []).toString("utf8"),
    stdoutCapReached: Boolean(session.stdoutCapReached ?? false),
    stderr: streamed ? "" : Buffer.concat(session.stderrChunks ?? []).toString("utf8"),
    stderrCapReached: Boolean(session.stderrCapReached ?? false)
  };
}

/**
 * 归一化 normalize process spawn params 相关数据。
 *
 * @param {unknown} params - params 参数。
 * @param {unknown} defaults - defaults 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeProcessSpawnParams(params = {}, defaults = {}) {
  const command = params.command;

  if (!Array.isArray(command) || command.length === 0) {
    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_PARAMS,
      "process/spawn command must be a non-empty array",
      {
        reason: "invalid_command"
      }
    );
  }

  const processHandle = normalizeProcessHandle(params.processHandle ?? params.process_handle);
  const cwd = String(requireProcessParam(params, "cwd"));

  if (!path.isAbsolute(cwd)) {
    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_PARAMS,
      "process/spawn cwd must be absolute",
      {
        reason: "invalid_cwd",
        cwd
      }
    );
  }

  const tty = Boolean(params.tty ?? false);
  const outputBytesCap = params.outputBytesCap ?? params.output_bytes_cap;
  const timeoutMs = params.timeoutMs ?? params.timeout_ms;

  if ((params.size ?? null) && !tty) {
    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_PARAMS,
      "process/spawn size requires tty: true",
      {
        reason: "size_requires_tty",
        processHandle
      }
    );
  }

  return {
    command: command.map(String),
    processHandle,
    cwd: path.resolve(cwd),
    tty,
    streamStdin: tty || Boolean(params.streamStdin ?? params.stream_stdin ?? false),
    streamStdoutStderr: tty || Boolean(params.streamStdoutStderr ?? params.stream_stdout_stderr ?? false),
    outputBytesCap: outputBytesCap === null
      ? null
      : Number.isFinite(Number(outputBytesCap))
        ? Math.max(0, Math.floor(Number(outputBytesCap)))
        : defaults.defaultOutputBytesCap ?? 1_000_000,
    timeoutMs: timeoutMs === null
      ? null
      : Number.isFinite(Number(timeoutMs))
        ? Math.max(0, Math.floor(Number(timeoutMs)))
        : defaults.defaultTimeoutMs ?? 30_000,
    env: params.env ?? null,
    size: params.size ? normalizeProcessTerminalSize(params.size) : null
  };
}

/**
 * 归一化 normalize process handle 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeProcessHandle(value) {
  const processHandle = String(value ?? "");

  if (!processHandle) {
    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_PARAMS,
      "processHandle is required",
      {
        reason: "missing_process_handle"
      }
    );
  }

  return processHandle;
}

/**
 * 归一化 normalize process terminal size 相关数据。
 *
 * @param {unknown} value - value 参数。
 * @returns {unknown} 返回处理后的结果。
 */
export function normalizeProcessTerminalSize(value = {}) {
  const rows = Number(value.rows);
  const cols = Number(value.cols ?? value.columns);

  if (!Number.isSafeInteger(rows) || rows <= 0 || !Number.isSafeInteger(cols) || cols <= 0) {
    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_PARAMS,
      "process terminal size requires positive rows and cols",
      {
        reason: "invalid_terminal_size"
      }
    );
  }

  return {
    rows,
    cols
  };
}

/**
 * 归一化 normalize process env 相关数据。
 *
 * @param {unknown} env - env 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function normalizeProcessEnv(env) {
  if (env == null) {
    return process.env;
  }

  const overrides = {};

  for (const [key, value] of Object.entries(env)) {
    if (value !== null) {
      overrides[key] = String(value);
    }
  }

  const merged = normalizeExecEnv(overrides);

  for (const [key, value] of Object.entries(env)) {
    if (value === null) {
      delete merged[key];
    }
  }

  return merged;
}

/**
 * 处理 require process param 相关逻辑。
 *
 * @param {unknown} params - params 参数。
 * @param {unknown} name - name 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function requireProcessParam(params, name) {
  const value = params?.[name];

  if (value == null || value === "") {
    throw createAppServerProtocolError(
      APP_SERVER_ERROR_CODES.INVALID_PARAMS,
      `Missing required param: ${name}`,
      {
        reason: "missing_param",
        param: name
      }
    );
  }

  return value;
}

/**
 * 处理 clamp buffer for stream 相关逻辑。
 *
 * @param {unknown} session - session 参数。
 * @param {unknown} stream - stream 参数。
 * @param {unknown} chunk - chunk 参数。
 * @param {unknown} cap - cap 参数。
 * @returns {unknown} 返回处理后的结果。
 */
function clampBufferForStream(session, stream, chunk, cap) {
  if (cap == null) {
    return {
      buffer: chunk,
      capReached: false
    };
  }

  const bytesKey = stream === "stdout" ? "stdoutBytes" : "stderrBytes";
  const current = session[bytesKey] ?? 0;
  const remaining = Math.max(0, cap - current);
  const buffer = remaining > 0 ? chunk.subarray(0, remaining) : Buffer.alloc(0);
  session[bytesKey] = current + buffer.length;

  return {
    buffer,
    capReached: chunk.length > remaining
  };
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
