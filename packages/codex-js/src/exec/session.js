import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  EXEC_RUNTIME_ERRORS,
  createExecRequest,
  normalizeExecEnv,
  spawnCommandForRequest
} from "./runtime.js";

export const COMMAND_SESSION_STATUSES = Object.freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CLOSED: "closed"
});

export class CommandSessionManager {
  constructor(options = {}) {
    this.sessions = new Map();
    this.nextNumericId = 1;
    this.defaultYieldTimeMs = options.defaultYieldTimeMs ?? 1000;
    this.defaultMaxOutputChars = options.defaultMaxOutputChars ?? 20000;
    this.onOutputDelta = options.onOutputDelta ?? null;
  }

  start(request = {}, options = {}) {
    const normalized = normalizeExecCommandRequest(request);
    const sessionId = options.sessionId ?? this.nextNumericId++;
    const processId = normalized.processId ?? String(sessionId);
    const duplicate = this.activeSessionForProcessId(processId);

    if (duplicate) {
      return createCommandSessionFailure({
        processId,
        command: normalized.command,
        cwd: normalized.cwd,
        error: "duplicate_process_id",
        output: `active exec session already exists for process_id: ${processId}`
      });
    }

    const session = {
      id: sessionId,
      processId,
      uuid: randomUUID(),
      command: normalized.command,
      cwd: normalized.cwd,
      request: normalized,
      status: options.status ?? COMMAND_SESSION_STATUSES.COMPLETED,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stdin: [],
      output: options.output ?? `dry-run: ${normalized.command}`,
      exitCode: options.exitCode ?? 0,
      error: options.error ?? null,
      dryRun: options.dryRun ?? true
    };

    this.sessions.set(String(sessionId), session);
    this.sessions.set(String(session.processId), session);

    return createCommandSessionResult(session, {
      output: session.output,
      chunkId: `${session.uuid}:0`,
      yieldTimeMs: normalized.yieldTimeMs,
      maxOutputChars: normalized.maxOutputChars
    });
  }

  write(request = {}) {
    const sessionId = normalizeSessionId(request.session_id ?? request.sessionId ?? request.process_id ?? request.processId);
    const session = this.lookup(sessionId);

    if (!session) {
      return createCommandSessionFailure({
        sessionId,
        error: "session_not_found",
        output: `exec session not found: ${sessionId}`
      });
    }

    if (request.close_stdin ?? request.closeStdin) {
      session.status = COMMAND_SESSION_STATUSES.CLOSED;
    }

    const chars = String(request.chars ?? "");

    if (chars) {
      session.stdin.push(chars);
    }

    session.updatedAt = new Date().toISOString();

    const stdinText = session.stdin.join("");
    const output = chars
      ? `stdin accepted for session ${session.id}: ${chars}`
      : session.output;

    return createCommandSessionResult(session, {
      output,
      stdin: stdinText,
      chunkId: `${session.uuid}:${session.stdin.length}`,
      yieldTimeMs: request.yield_time_ms ?? request.yieldTimeMs,
      maxOutputChars: request.max_output_tokens ?? request.maxOutputChars
    });
  }

  get(sessionId) {
    return this.lookup(sessionId);
  }

  list() {
    return Array.from(new Set(this.sessions.values()));
  }

  lookup(sessionId) {
    return this.sessions.get(String(sessionId)) ?? null;
  }

  activeSessionForProcessId(processId) {
    const session = this.lookup(processId);

    return isActiveCommandSession(session) ? session : null;
  }

  setOutputDeltaHandler(handler) {
    this.onOutputDelta = typeof handler === "function" ? handler : null;

    return this;
  }

  emitOutputDelta(session, stream, chunk, options = {}) {
    if (!this.onOutputDelta || !session) {
      return;
    }

    const buffer = Buffer.from(chunk ?? "");

    if (buffer.length === 0) {
      return;
    }

    this.onOutputDelta({
      session,
      stream,
      chunk: buffer,
      delta: buffer.toString("utf8"),
      deltaBase64: buffer.toString("base64"),
      chunkId: options.chunkId ?? `${session.uuid}:${stream}:${Date.now()}`,
      capReached: Boolean(options.capReached ?? false)
    });
  }

  resize(request = {}) {
    const sessionId = normalizeSessionId(request.session_id ?? request.sessionId ?? request.process_id ?? request.processId);
    const session = this.lookup(sessionId);

    if (!session) {
      return createCommandSessionFailure({
        sessionId,
        error: "session_not_found",
        output: `exec session not found: ${sessionId}`
      });
    }

    session.terminalSize = normalizeTerminalSize(request.size ?? request);
    session.updatedAt = new Date().toISOString();

    return createCommandSessionResult(session, {
      output: session.output,
      chunkId: `${session.uuid}:resize`
    });
  }
}

export class BlockedCommandSessionManager extends CommandSessionManager {
  start(request = {}) {
    const normalized = normalizeExecCommandRequest(request);

    return createCommandSessionFailure({
      command: normalized.command,
      cwd: normalized.cwd,
      error: EXEC_RUNTIME_ERRORS.BLOCKED,
      output: "exec command sessions are blocked by configuration"
    });
  }

  write(request = {}) {
    return createCommandSessionFailure({
      sessionId: request.session_id ?? request.sessionId ?? request.process_id ?? request.processId ?? null,
      error: EXEC_RUNTIME_ERRORS.BLOCKED,
      output: "stdin writes are blocked by configuration"
    });
  }
}

export class RealCommandSessionManager extends CommandSessionManager {
  constructor(options = {}) {
    super(options);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
  }

  start(request = {}, options = {}) {
    const normalized = normalizeExecCommandRequest(request);
    const sessionId = options.sessionId ?? this.nextNumericId++;
    const processId = normalized.processId ?? String(sessionId);
    const duplicate = this.activeSessionForProcessId(processId);

    if (duplicate) {
      return createCommandSessionFailure({
        processId,
        command: normalized.command,
        cwd: normalized.cwd,
        error: "duplicate_process_id",
        output: `active exec session already exists for process_id: ${processId}`
      });
    }

    const session = {
      id: sessionId,
      processId,
      uuid: randomUUID(),
      command: normalized.command,
      cwd: normalized.cwd,
      request: normalized,
      status: COMMAND_SESSION_STATUSES.RUNNING,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stdin: [],
      stdoutChunks: [],
      stderrChunks: [],
      output: "",
      exitCode: null,
      error: null,
      dryRun: false,
      child: null,
      stdinClosed: false,
      timeout: null,
      timedOut: false
    };

    this.sessions.set(String(sessionId), session);
    this.sessions.set(String(session.processId), session);

    try {
      const command = spawnCommandForRequest(normalized);
      const child = spawn(command.file, command.args, {
        cwd: path.resolve(normalized.cwd),
        env: normalizeExecEnv(normalized.env),
        windowsHide: true,
        stdio: [
          normalized.streamStdin ? "pipe" : "ignore",
          "pipe",
          "pipe"
        ]
      });

      session.child = child;

      child.stdout?.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        session.stdoutChunks.push(buffer);
        session.updatedAt = new Date().toISOString();
        this.emitOutputDelta(session, "stdout", buffer, {
          chunkId: `${session.uuid}:stdout:${session.stdoutChunks.length}`
        });
      });
      child.stderr?.on("data", (chunk) => {
        const buffer = Buffer.from(chunk);
        session.stderrChunks.push(buffer);
        session.updatedAt = new Date().toISOString();
        this.emitOutputDelta(session, "stderr", buffer, {
          chunkId: `${session.uuid}:stderr:${session.stderrChunks.length}`
        });
      });
      child.on("error", (error) => {
        session.error = EXEC_RUNTIME_ERRORS.SPAWN_ERROR;
        session.status = COMMAND_SESSION_STATUSES.FAILED;
        session.exitCode = 1;
        session.output = error.message;
        session.updatedAt = new Date().toISOString();
        clearTimeoutIfNeeded(session.timeout);
      });
      child.on("close", (code, signal) => {
        clearTimeoutIfNeeded(session.timeout);
        session.exitCode = session.timedOut ? 124 : code ?? (signal ? 1 : 0);
        session.output = sessionOutput(session, this.maxOutputBytes);
        session.status = session.exitCode === 0
          ? COMMAND_SESSION_STATUSES.COMPLETED
          : COMMAND_SESSION_STATUSES.FAILED;
        session.error = session.timedOut ? EXEC_RUNTIME_ERRORS.TIMED_OUT : null;
        session.updatedAt = new Date().toISOString();
      });

      const timeoutMs = normalized.timeout_ms ?? this.defaultTimeoutMs;

      if (timeoutMs != null) {
        session.timeout = setTimeout(() => {
          session.timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs);
      }
    } catch (error) {
      session.status = COMMAND_SESSION_STATUSES.FAILED;
      session.exitCode = 1;
      session.error = EXEC_RUNTIME_ERRORS.SPAWN_ERROR;
      session.output = error.message;
      session.updatedAt = new Date().toISOString();
    }

    return createCommandSessionResult(session, {
      output: session.output,
      chunkId: `${session.uuid}:0`,
      maxOutputChars: normalized.maxOutputChars
    });
  }

  write(request = {}) {
    const sessionId = normalizeSessionId(request.session_id ?? request.sessionId ?? request.process_id ?? request.processId);
    const session = this.lookup(sessionId);

    if (!session) {
      return createCommandSessionFailure({
        sessionId,
        error: "session_not_found",
        output: `exec session not found: ${sessionId}`
      });
    }

    const chars = String(request.chars ?? "");

    if (chars) {
      if (!session.request.streamStdin) {
        return createCommandSessionFailure({
          sessionId,
          command: session.command,
          cwd: session.cwd,
          error: "stdin_not_enabled",
          output: "stdin streaming is not enabled for this command session"
        });
      }

      if (session.stdinClosed || !session.child?.stdin?.writable) {
        return createCommandSessionFailure({
          sessionId,
          command: session.command,
          cwd: session.cwd,
          error: "stdin_closed",
          output: "stdin is already closed"
        });
      }

      session.stdin.push(chars);
      session.child.stdin.write(chars);
    }

    if (request.close_stdin ?? request.closeStdin) {
      session.stdinClosed = true;
      session.child?.stdin?.end();
    }

    session.updatedAt = new Date().toISOString();
    session.output = sessionOutput(session, this.maxOutputBytes);

    return createCommandSessionResult(session, {
      output: session.output,
      stdin: session.stdin.join(""),
      chunkId: `${session.uuid}:${session.stdin.length}`,
      maxOutputChars: request.max_output_tokens ?? request.maxOutputChars
    });
  }

  terminate(sessionId) {
    const session = this.lookup(sessionId);

    if (!session) {
      return createCommandSessionFailure({
        sessionId,
        error: "session_not_found",
        output: `exec session not found: ${sessionId}`
      });
    }

    session.child?.kill("SIGTERM");
    session.status = COMMAND_SESSION_STATUSES.CLOSED;
    session.updatedAt = new Date().toISOString();

    return createCommandSessionResult(session, {
      output: sessionOutput(session, this.maxOutputBytes),
      chunkId: `${session.uuid}:terminate`
    });
  }
}

export function normalizeExecCommandRequest(request = {}) {
  const command = request.cmd ?? request.command ?? "";
  const argv = Array.isArray(command) ? command.map(String) : null;
  const execRequest = createExecRequest({
    command,
    argv,
    cwd: request.workdir ?? request.cwd,
    timeoutMs: request.timeout_ms ?? request.timeoutMs,
    env: request.env
  });

  return {
    ...execRequest,
    processId: request.process_id ?? request.processId ?? null,
    yieldTimeMs: request.yield_time_ms ?? request.yieldTimeMs ?? null,
    maxOutputChars: request.max_output_tokens ?? request.maxOutputChars ?? null,
    tty: Boolean(request.tty ?? false),
    streamStdin: Boolean(request.stream_stdin ?? request.streamStdin ?? request.tty ?? false)
  };
}

export function createCommandSessionResult(session, options = {}) {
  const output = clampText(options.output ?? session.output ?? "", options.maxOutputChars);

  return {
    status: session.status,
    session_id: session.id,
    process_id: session.processId ?? String(session.id),
    command: session.command,
    cwd: session.cwd,
    chunk_id: options.chunkId ?? `${session.uuid}:0`,
    wall_time_seconds: secondsSince(session.startedAt),
    exit_code: session.exitCode,
    output,
    stdin: options.stdin ?? null,
    original_token_count: estimateTokenCount(String(options.output ?? session.output ?? "")),
    dry_run: Boolean(session.dryRun),
    error: session.error
  };
}

export function createCommandSessionFailure(options = {}) {
  return {
    status: COMMAND_SESSION_STATUSES.FAILED,
    session_id: options.sessionId ?? null,
    process_id: options.processId ?? null,
    command: options.command ?? "",
    cwd: options.cwd ?? null,
    chunk_id: options.chunkId ?? null,
    wall_time_seconds: 0,
    exit_code: options.exitCode ?? 1,
    output: String(options.output ?? ""),
    stdin: options.stdin ?? null,
    original_token_count: estimateTokenCount(options.output ?? ""),
    dry_run: true,
    error: options.error ?? "failed"
  };
}

export function commandSessionResultToText(result = {}) {
  return JSON.stringify({
    chunk_id: result.chunk_id ?? null,
    wall_time_seconds: result.wall_time_seconds ?? 0,
    exit_code: result.exit_code ?? null,
    session_id: result.session_id ?? null,
    process_id: result.process_id ?? null,
    original_token_count: result.original_token_count ?? 0,
    output: result.output ?? ""
  });
}

function normalizeSessionId(value) {
  const number = Number(value);

  if (Number.isSafeInteger(number) && number > 0) {
    return number;
  }

  return String(value ?? "");
}

function normalizeTerminalSize(value = {}) {
  const rows = Number(value.rows);
  const cols = Number(value.cols ?? value.columns);

  return {
    rows: Number.isSafeInteger(rows) && rows > 0 ? rows : null,
    cols: Number.isSafeInteger(cols) && cols > 0 ? cols : null
  };
}

function secondsSince(isoTimestamp) {
  const started = Date.parse(isoTimestamp ?? "");

  if (!Number.isFinite(started)) {
    return 0;
  }

  return Math.max(0, (Date.now() - started) / 1000);
}

function estimateTokenCount(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

function clampText(text, maxChars) {
  const value = String(text ?? "");
  const limit = Number(maxChars);

  if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) {
    return value;
  }

  return value.slice(0, Math.floor(limit));
}

function sessionOutput(session, maxBytes) {
  const stdout = decodeChunks(session.stdoutChunks ?? [], maxBytes);
  const stderr = decodeChunks(session.stderrChunks ?? [], maxBytes);

  return `${stdout}${stderr}`;
}

function decodeChunks(chunks, maxBytes = 1_000_000) {
  const buffer = Buffer.concat(chunks);

  if (buffer.length <= maxBytes) {
    return buffer.toString("utf8");
  }

  return buffer.subarray(0, maxBytes).toString("utf8");
}

function clearTimeoutIfNeeded(timeout) {
  if (timeout) {
    clearTimeout(timeout);
  }
}

function isActiveCommandSession(session) {
  return session?.status === COMMAND_SESSION_STATUSES.RUNNING;
}
