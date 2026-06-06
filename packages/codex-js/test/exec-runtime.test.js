import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  BlockedExecRuntime,
  DryRunExecRuntime,
  ExecRuntime,
  RealExecRuntime,
  blockedExecResult,
  decodeAndClampOutput,
  createExecRequest,
  createExecResult,
  createExecToolCallOutput,
  normalizeExecEnv,
  shellCommandForPlatform,
  spawnCommandForRequest
} from "../src/index.js";

test("createExecRequest normalizes command request fields", () => {
  assert.deepEqual(createExecRequest({
    command: "npm test",
    cwd: "/workspace",
    timeoutMs: 100,
    env: {
      CI: "1"
    }
  }), {
    command: "npm test",
    cwd: "/workspace",
    timeout_ms: 100,
    env: {
      CI: "1"
    }
  });
});

test("createExecResult wraps output metadata", () => {
  const output = createExecToolCallOutput({
    stdout: "ok"
  });
  const result = createExecResult({
    output,
    executed: true,
    dryRun: false
  });

  assert.equal(result.output.stdout.text, "ok");
  assert.equal(result.executed, true);
  assert.equal(result.dry_run, false);
  assert.equal(result.error, null);
});

test("DryRunExecRuntime returns dry-run output without execution", async () => {
  const runtime = new DryRunExecRuntime();
  const result = await runtime.run(createExecRequest({
    command: "npm test",
    cwd: "/workspace"
  }));

  assert.equal(result.executed, false);
  assert.equal(result.dry_run, true);
  assert.equal(result.output.aggregated_output.text, "dry-run: npm test");
});

test("BlockedExecRuntime refuses execution without spawning", async () => {
  const runtime = new BlockedExecRuntime({
    reason: "approval_required"
  });
  const result = await runtime.run(createExecRequest({
    command: "npm test",
    cwd: "/workspace"
  }));

  assert.equal(result.executed, false);
  assert.equal(result.dry_run, true);
  assert.equal(result.error, "blocked: approval_required");
  assert.equal(result.output.exit_code, 1);
  assert.match(result.output.stderr.text, /approval_required/);
});

test("RealExecRuntime executes commands and captures stdout and stderr", async () => {
  const script = await createTempExecScript("console.log('out'); console.error('err');");
  const runtime = new RealExecRuntime({
    defaultTimeoutMs: 5000
  });
  const result = await runtime.run(createExecRequest({
    command: [process.execPath, script.filePath],
    cwd: process.cwd()
  }));

  try {
    assert.equal(result.executed, true);
    assert.equal(result.dry_run, false);
    assert.equal(result.error, null);
    assert.equal(result.output.exit_code, 0);
    assert.match(result.output.stdout.text, /out/);
    assert.match(result.output.stderr.text, /err/);
    assert.match(result.output.aggregated_output.text, /out/);
    assert.match(result.output.aggregated_output.text, /err/);
  } finally {
    await script.cleanup();
  }
});

test("RealExecRuntime preserves non-zero exit codes", async () => {
  const script = await createTempExecScript("process.exit(7);");
  const runtime = new RealExecRuntime({
    defaultTimeoutMs: 5000
  });
  const result = await runtime.run(createExecRequest({
    command: [process.execPath, script.filePath],
    cwd: process.cwd()
  }));

  try {
    assert.equal(result.executed, true);
    assert.equal(result.error, null);
    assert.equal(result.output.exit_code, 7);
  } finally {
    await script.cleanup();
  }
});

test("RealExecRuntime supports environment overrides", async () => {
  const script = await createTempExecScript("process.stdout.write(process.env.CODEX_JS_TEST_ENV);");
  const runtime = new RealExecRuntime({
    defaultTimeoutMs: 5000
  });
  const result = await runtime.run(createExecRequest({
    command: [process.execPath, script.filePath],
    cwd: process.cwd(),
    env: {
      CODEX_JS_TEST_ENV: "from-env"
    }
  }));

  try {
    assert.equal(result.output.stdout.text, "from-env");
  } finally {
    await script.cleanup();
  }
});

test("normalizeExecEnv filters blocked and non-allowed keys", () => {
  const env = normalizeExecEnv({
    SAFE_FLAG: "1",
    GITHUB_TOKEN: "secret",
    OTHER_FLAG: "2"
  }, {
    baseEnv: {
      OPENAI_API_KEY: "secret",
      PATH: "bin"
    },
    blockedEnvKeys: ["OPENAI_API_KEY", "GITHUB_TOKEN"],
    allowedEnvKeys: ["PATH", "SAFE_FLAG"]
  });

  assert.deepEqual(env, {
    PATH: "bin",
    SAFE_FLAG: "1"
  });
});

test("RealExecRuntime times out long-running commands", async () => {
  const script = await createTempExecScript("setTimeout(() => {}, 1000);");
  const runtime = new RealExecRuntime({
    defaultTimeoutMs: 50
  });
  const result = await runtime.run(createExecRequest({
    command: [process.execPath, script.filePath],
    cwd: process.cwd()
  }));

  try {
    assert.equal(result.executed, true);
    assert.equal(result.error, "timed_out");
    assert.equal(result.output.timed_out, true);
    assert.equal(result.output.exit_code, 124);
  } finally {
    await script.cleanup();
  }
});

test("ExecRuntime base class requires implementation", async () => {
  const runtime = new ExecRuntime();

  await assert.rejects(
    () => runtime.run(createExecRequest({ command: "npm test" })),
    /must be implemented/
  );
});

test("blockedExecResult records blocked decision", () => {
  const result = blockedExecResult({
    decision: "prompt",
    output: createExecToolCallOutput({
      stderr: "blocked"
    })
  });

  assert.equal(result.executed, false);
  assert.equal(result.dry_run, true);
  assert.equal(result.error, "blocked: prompt");
  assert.equal(result.output.aggregated_output.text, "blocked");
});

test("shellCommandForPlatform returns platform shell invocations", () => {
  assert.deepEqual(shellCommandForPlatform("echo hi", {
    platform: "win32"
  }), {
    file: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "echo hi"
    ]
  });
  assert.deepEqual(shellCommandForPlatform("echo hi", {
    platform: "linux"
  }), {
    file: "sh",
    args: ["-c", "echo hi"]
  });
});

test("spawnCommandForRequest supports direct argv execution", () => {
  assert.deepEqual(spawnCommandForRequest(createExecRequest({
    command: ["node", "script.mjs"]
  })), {
    file: "node",
    args: ["script.mjs"]
  });
});

test("decodeAndClampOutput truncates large buffers", () => {
  assert.equal(decodeAndClampOutput([Buffer.from("abcdef")], 3), "abc");
});

async function createTempExecScript(source) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-js-exec-"));
  const filePath = path.join(directory, "script.mjs");

  await writeFile(filePath, source, "utf8");

  return {
    filePath,
    async cleanup() {
      await rm(directory, {
        recursive: true,
        force: true
      });
    }
  };
}
