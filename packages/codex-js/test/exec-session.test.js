/**
 * 中文模块说明：test/exec-session.test.js
 *
 * Node 内置测试套件，覆盖 codex-js 的核心运行时和工具行为。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BlockedCommandSessionManager,
  COMMAND_SESSION_STATUSES,
  CommandSessionManager,
  RealCommandSessionManager,
  commandSessionResultToText,
  normalizeExecCommandRequest
} from "../src/index.js";

test("CommandSessionManager starts dry-run sessions and accepts stdin writes", () => {
  const manager = new CommandSessionManager();
  const started = manager.start({
    cmd: "npm test",
    workdir: "/workspace",
    processId: "proc-1",
    stream_stdin: true
  });

  assert.equal(started.status, COMMAND_SESSION_STATUSES.COMPLETED);
  assert.equal(started.session_id, 1);
  assert.equal(started.process_id, "proc-1");
  assert.equal(started.command, "npm test");
  assert.equal(started.cwd, "/workspace");
  assert.equal(started.dry_run, true);
  assert.match(started.output, /dry-run: npm test/);

  const write = manager.write({
    process_id: "proc-1",
    chars: "echo hi\n"
  });

  assert.equal(write.session_id, started.session_id);
  assert.equal(write.process_id, "proc-1");
  assert.match(write.output, /stdin accepted/);
  assert.equal(write.stdin, "echo hi\n");

  const resized = manager.resize({
    process_id: "proc-1",
    size: {
      rows: 40,
      cols: 120
    }
  });

  assert.equal(resized.chunk_id.endsWith(":resize"), true);
  assert.deepEqual(manager.get("proc-1").terminalSize, {
    rows: 40,
    cols: 120
  });

  const text = JSON.parse(commandSessionResultToText(write));
  assert.equal(text.session_id, started.session_id);
  assert.equal(text.process_id, "proc-1");
  assert.equal(typeof text.output, "string");
});

test("CommandSessionManager reports missing sessions and blocked manager failures", () => {
  const manager = new CommandSessionManager();
  const missing = manager.write({
    session_id: 99,
    chars: "x"
  });

  assert.equal(missing.status, COMMAND_SESSION_STATUSES.FAILED);
  assert.equal(missing.error, "session_not_found");

  const blocked = new BlockedCommandSessionManager().start({
    cmd: "npm test"
  });

  assert.equal(blocked.status, COMMAND_SESSION_STATUSES.FAILED);
  assert.equal(blocked.error, "blocked");
});

test("normalizeExecCommandRequest maps Codex exec_command arguments", () => {
  const normalized = normalizeExecCommandRequest({
    cmd: "npm test",
    workdir: "/workspace",
    process_id: "proc-1",
    tty: true,
    yield_time_ms: 10,
    max_output_tokens: 100
  });

  assert.equal(normalized.command, "npm test");
  assert.equal(normalized.processId, "proc-1");
  assert.equal(normalized.cwd, "/workspace");
  assert.equal(normalized.tty, true);
  assert.equal(normalized.streamStdin, true);
  assert.equal(normalized.yieldTimeMs, 10);
  assert.equal(normalized.maxOutputChars, 100);
});

test("RealCommandSessionManager runs a process, writes stdin, and closes stdin", async () => {
  const deltas = [];
  const manager = new RealCommandSessionManager({
    defaultTimeoutMs: 5000,
    /**
     * 处理 on output delta 相关逻辑。
     *
     * @param {unknown} delta - delta 参数。
     * @returns {unknown} 返回处理后的结果。
     */
    onOutputDelta(delta) {
      deltas.push(delta);
    }
  });
  const started = manager.start({
    process_id: "real-proc",
    command: [
      process.execPath,
      "-e",
      "process.stdin.on('data', d => process.stdout.write('got:' + d)); process.stdin.on('end', () => process.stdout.write('done'))"
    ],
    stream_stdin: true
  });

  assert.equal(started.status, COMMAND_SESSION_STATUSES.RUNNING);
  assert.equal(started.process_id, "real-proc");
  assert.equal(started.dry_run, false);

  manager.write({
    process_id: "real-proc",
    chars: "hello\n",
    close_stdin: true
  });

  const completed = await waitForSessionStatus(manager, started.session_id, [
    COMMAND_SESSION_STATUSES.COMPLETED,
    COMMAND_SESSION_STATUSES.FAILED
  ]);

  assert.equal(completed.status, COMMAND_SESSION_STATUSES.COMPLETED);
  assert.equal(completed.exitCode, 0);

  const polled = manager.write({
    process_id: "real-proc",
    chars: ""
  });

  assert.match(polled.output, /got:hello/);
  assert.match(polled.output, /done/);
  assert.equal(deltas.some((delta) => delta.stream === "stdout"), true);
  assert.equal(deltas.some((delta) => /got:hello|done/.test(delta.delta)), true);
});

test("RealCommandSessionManager rejects stdin when streaming was not enabled", () => {
  const manager = new RealCommandSessionManager({
    defaultTimeoutMs: 5000
  });
  const started = manager.start({
    command: [
      process.execPath,
      "-e",
      "setTimeout(() => {}, 1000)"
    ]
  });
  const write = manager.write({
    session_id: started.session_id,
    chars: "hello"
  });

  manager.terminate(started.session_id);

  assert.equal(write.status, COMMAND_SESSION_STATUSES.FAILED);
  assert.equal(write.error, "stdin_not_enabled");
});

test("RealCommandSessionManager rejects duplicate active process ids", async () => {
  const manager = new RealCommandSessionManager({
    defaultTimeoutMs: 5000
  });
  const first = manager.start({
    process_id: "dup-proc",
    command: [
      process.execPath,
      "-e",
      "setTimeout(() => {}, 500)"
    ]
  });
  const duplicate = manager.start({
    process_id: "dup-proc",
    command: [
      process.execPath,
      "-e",
      "console.log('second')"
    ]
  });

  manager.terminate(first.session_id);

  assert.equal(first.status, COMMAND_SESSION_STATUSES.RUNNING);
  assert.equal(duplicate.status, COMMAND_SESSION_STATUSES.FAILED);
  assert.equal(duplicate.error, "duplicate_process_id");
  assert.match(duplicate.output, /active exec session already exists/);

  await waitForSessionStatus(manager, first.session_id, [
    COMMAND_SESSION_STATUSES.CLOSED,
    COMMAND_SESSION_STATUSES.COMPLETED,
    COMMAND_SESSION_STATUSES.FAILED
  ]);
});

/**
 * 等待 wait for session status 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} manager - manager 参数。
 * @param {unknown} sessionId - sessionId 参数。
 * @param {unknown} statuses - statuses 参数。
 * @returns {unknown} 返回处理后的结果。
 */
async function waitForSessionStatus(manager, sessionId, statuses) {
  const wanted = new Set(statuses);

  for (let index = 0; index < 50; index += 1) {
    const session = manager.get(sessionId);

    if (session && wanted.has(session.status)) {
      return session;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`session ${sessionId} did not reach ${Array.from(wanted).join(", ")}`);
}
