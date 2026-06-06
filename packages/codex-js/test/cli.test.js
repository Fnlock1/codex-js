import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { parseArgs, runCli } from "../src/cli.js";

test("CLI help prints usage", async () => {
  const output = createWritableCapture();
  const exitCode = await runCli(["--help"], {
    stdout: output,
    stderr: createWritableCapture()
  });

  assert.equal(exitCode, 0);
  assert.match(output.text, /Usage:/);
  assert.match(output.text, /codex-js exec <prompt>/);
});

test("tools list prints registered tool capability summary", async () => {
  const output = createWritableCapture();
  const exitCode = await runCli(["tools", "list"], {
    stdout: output,
    stderr: createWritableCapture()
  });

  assert.equal(exitCode, 0);
  assert.match(output.text, /codex-js tools/);
  assert.match(output.text, /registered: 21/);
  assert.match(output.text, /shell_command/);
  assert.match(output.text, /apply_patch/);
  assert.doesNotMatch(output.text, /web_search/);
});

test("tools inspect --json includes hosted tools when enabled", async () => {
  const output = createWritableCapture();
  const exitCode = await runCli([
    "tools",
    "inspect",
    "--json",
    "--enable-hosted-tools",
    "--web-search-url",
    "http://127.0.0.1:8787/search"
  ], {
    stdout: output,
    stderr: createWritableCapture()
  });

  assert.equal(exitCode, 0);
  const report = JSON.parse(output.text);
  assert.equal(report.summary.registeredTools, 23);
  assert.equal(report.summary.hostedToolsEnabled, true);
  assert.ok(report.tools.some((tool) => tool.name === "web_search" && tool.configured));
  assert.ok(report.tools.some((tool) => tool.name === "image_generation" && !tool.configured));
});

test("tools doctor reports upstream gaps and gated capabilities", async () => {
  const output = createWritableCapture();
  const exitCode = await runCli(["tools", "doctor"], {
    stdout: output,
    stderr: createWritableCapture()
  });

  assert.equal(exitCode, 0);
  assert.match(output.text, /shell enabled: no/);
  assert.match(output.text, /apply_patch writes: no/);
  assert.match(output.text, /hosted_web_search/);
  assert.match(output.text, /sandbox/);
});

test("exec --json emits valid JSONL thread events", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-cli-"));
  const output = createWritableCapture();

  try {
    const exitCode = await runCli([
      "exec",
      "hello",
      "--json",
      "--session-store",
      sessionStoreDirectory
    ], {
      stdout: output,
      stderr: createWritableCapture()
    });

    assert.equal(exitCode, 0);

    const events = output.text.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].type, "thread.started");
    assert.match(events[0].thread_id, /^[0-9a-f-]{36}$/);
    assert.equal(events[0].thread_id.startsWith("thread_"), false);
    assert.equal(events[1].type, "turn.started");
    assert.ok(events.some((event) => event.type === "item.completed"));
    assert.equal(events.at(-1).type, "turn.completed");
  } finally {
    await rm(sessionStoreDirectory, { recursive: true, force: true });
  }
});

test("exec --json-stream is an alias for JSONL thread events", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-cli-json-stream-"));
  const output = createWritableCapture();

  try {
    const exitCode = await runCli([
      "exec",
      "hello",
      "--json-stream",
      "--session-store",
      sessionStoreDirectory
    ], {
      stdout: output,
      stderr: createWritableCapture()
    });

    assert.equal(exitCode, 0);

    const events = output.text.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].type, "thread.started");
    assert.equal(events[1].type, "turn.started");
    assert.equal(events.at(-1).type, "turn.completed");
  } finally {
    await rm(sessionStoreDirectory, {
      recursive: true,
      force: true
    });
  }
});

test("CLI parses max tool iteration override", () => {
  const parsed = parseArgs([
    "exec",
    "hello",
    "--max-tool-iterations",
    "12"
  ]);

  assert.equal(parsed.maxToolIterations, 12);
  assert.deepEqual(parsed.errors, []);

  const invalid = parseArgs([
    "exec",
    "hello",
    "--max-tool-iterations",
    "0"
  ]);

  assert.match(invalid.errors[0], /positive integer/);
});

test("exec human output writes final answer to stderr", async () => {
  const stdout = createWritableCapture();
  const stderr = createWritableCapture();
  const exitCode = await runCli([
    "exec",
    "hello",
    "--mock-response",
    "done"
  ], {
    stdout,
    stderr
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.text, "");
  assert.equal(stderr.text, "done\n");
});

test("exec can use a local model adapter module", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-cli-model-adapter-"));

  try {
    const adapterPath = join(dir, "adapter.mjs");
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    await writeFile(adapterPath, `
export function generate(prompt) {
  return "adapter response: " + prompt.inputText;
}
`, "utf8");

    const exitCode = await runCli([
      "exec",
      "hello",
      "--model-adapter",
      adapterPath
    ], {
      stdout,
      stderr
    });

    assert.equal(exitCode, 0);
    assert.equal(stdout.text, "");
    assert.equal(stderr.text, "adapter response: hello\n");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("exec passes CLI model options to a local adapter module", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-cli-model-options-"));

  try {
    const adapterPath = join(dir, "adapter.mjs");
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    await writeFile(adapterPath, `
export function generate(prompt, context) {
  return context.adapterOptions.prefix + prompt.inputText + ":" + context.adapterOptions.temperature;
}
`, "utf8");

    const exitCode = await runCli([
      "exec",
      "hello",
      "--model-adapter",
      adapterPath,
      "--model-option",
      "prefix=custom:",
      "--model-options-json",
      "{\"temperature\":0.4}"
    ], {
      stdout,
      stderr
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr.text, "custom:hello:0.4\n");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("exec can load model adapter settings from config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-cli-model-config-"));

  try {
    const adapterPath = join(dir, "adapter.mjs");
    const configPath = join(dir, "codex-js.json");
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    await writeFile(adapterPath, `
export function generate(prompt, context) {
  return context.adapterOptions.prefix + prompt.inputText;
}
`, "utf8");
    await writeFile(configPath, JSON.stringify({
      model: {
        provider: "plugin",
        adapterPath,
        options: {
          prefix: "configured:"
        }
      }
    }), "utf8");

    const exitCode = await runCli([
      "exec",
      "hello",
      "--config",
      configPath
    ], {
      stdout,
      stderr
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr.text, "configured:hello\n");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("exec can run approved model shell tool calls and feed output back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-cli-agent-shell-"));

  try {
    const adapterPath = join(dir, "adapter.mjs");
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    await writeFile(adapterPath, `
let turn = 0;

export function generate(prompt) {
  turn += 1;

  if (turn === 1) {
    return {
      type: "function_call",
      callId: "call-shell",
      name: "shell_command",
      arguments: {
        command: "node -e \\"process.stdout.write('agent-shell-ok')\\""
      }
    };
  }

  return "final:" + prompt.responseInputItems[0].output.body;
}
`, "utf8");

    const exitCode = await runCli([
      "exec",
      "run shell",
      "--model-adapter",
      adapterPath,
      "--allow-shell",
      "--yes",
      "--cwd",
      dir
    ], {
      stdout,
      stderr
    });

    assert.equal(exitCode, 0);
    assert.match(stderr.text, /final:agent-shell-ok/);
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("exec can apply approved model patches and feed output back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-cli-agent-patch-"));

  try {
    const adapterPath = join(dir, "adapter.mjs");
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    await writeFile(adapterPath, `
let turn = 0;

export function generate(prompt) {
  turn += 1;

  if (turn === 1) {
    return {
      type: "function_call",
      callId: "call-patch",
      name: "apply_patch",
      arguments: {
        patch: [
          "*** Begin Patch",
          "*** Add File: created.txt",
          "+created by agent",
          "*** End Patch"
        ].join("\\n")
      }
    };
  }

  return "patched:" + prompt.responseInputItems[0].output.success;
}
`, "utf8");

    const exitCode = await runCli([
      "exec",
      "apply patch",
      "--model-adapter",
      adapterPath,
      "--allow-apply-patch",
      "--yes",
      "--cwd",
      dir
    ], {
      stdout,
      stderr
    });

    assert.equal(exitCode, 0);
    assert.match(stderr.text, /patched:true/);
    assert.equal(await readFile(join(dir, "created.txt"), "utf8"), "created by agent");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("exec can feed read_file tool output back into the model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-cli-file-loop-"));

  try {
    const adapterPath = join(dir, "adapter.mjs");
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    await writeFile(join(dir, "notes.txt"), "file tool content", "utf8");
    await writeFile(adapterPath, `
let turn = 0;

export function generate(prompt) {
  turn += 1;

  if (turn === 1) {
    return {
      type: "function_call",
      callId: "call-read",
      name: "read_file",
      arguments: {
        path: "notes.txt"
      }
    };
  }

  return "read:" + prompt.responseInputItems[0].output.body;
}
`, "utf8");

    const exitCode = await runCli([
      "exec",
      "read notes",
      "--model-adapter",
      adapterPath,
      "--cwd",
      dir
    ], {
      stdout,
      stderr
    });

    assert.equal(exitCode, 0);
    assert.match(stderr.text, /read:file tool content/);
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("exec sandbox blocks approved shell commands outside workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-cli-sandbox-shell-"));

  try {
    const adapterPath = join(dir, "adapter.mjs");
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    await writeFile(adapterPath, `
let turn = 0;

export function generate(prompt) {
  turn += 1;

  if (turn === 1) {
    return {
      type: "function_call",
      callId: "call-shell",
      name: "shell_command",
      arguments: {
        command: "node -e \\"process.stdout.write('should-not-run')\\"",
        cwd: "${dirname(dir).replaceAll("\\", "\\\\")}"
      }
    };
  }

  return "sandbox:" + prompt.responseInputItems[0].output.body;
}
`, "utf8");

    const exitCode = await runCli([
      "exec",
      "run outside",
      "--model-adapter",
      adapterPath,
      "--allow-shell",
      "--yes",
      "--cwd",
      dir
    ], {
      stdout,
      stderr
    });

    assert.equal(exitCode, 0);
    assert.match(stderr.text, /sandbox blocked/);
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("exec sandbox blocks network-risk shell commands by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-cli-sandbox-network-"));

  try {
    const adapterPath = join(dir, "adapter.mjs");
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    await writeFile(adapterPath, `
let turn = 0;

export function generate(prompt) {
  turn += 1;

  if (turn === 1) {
    return {
      type: "function_call",
      callId: "call-network",
      name: "shell_command",
      arguments: {
        command: "npm install"
      }
    };
  }

  return "sandbox:" + prompt.responseInputItems[0].output.body;
}
`, "utf8");

    const exitCode = await runCli([
      "exec",
      "network command",
      "--model-adapter",
      adapterPath,
      "--allow-shell",
      "--yes",
      "--cwd",
      dir
    ], {
      stdout,
      stderr
    });

    assert.equal(exitCode, 0);
    assert.match(stderr.text, /network disabled by sandbox/);
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("exec read-only sandbox blocks approved apply_patch writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-cli-sandbox-patch-"));

  try {
    const adapterPath = join(dir, "adapter.mjs");
    const stdout = createWritableCapture();
    const stderr = createWritableCapture();
    await writeFile(adapterPath, `
let turn = 0;

export function generate(prompt) {
  turn += 1;

  if (turn === 1) {
    return {
      type: "function_call",
      callId: "call-patch",
      name: "apply_patch",
      arguments: {
        patch: [
          "*** Begin Patch",
          "*** Add File: blocked.txt",
          "+blocked",
          "*** End Patch"
        ].join("\\n")
      }
    };
  }

  return "sandbox:" + prompt.responseInputItems[0].output.body;
}
`, "utf8");

    const exitCode = await runCli([
      "exec",
      "patch blocked",
      "--model-adapter",
      adapterPath,
      "--allow-apply-patch",
      "--yes",
      "--sandbox",
      "read-only",
      "--cwd",
      dir
    ], {
      stdout,
      stderr
    });

    assert.equal(exitCode, 0);
    assert.match(stderr.text, /sandbox/);
    await assert.rejects(() => readFile(join(dir, "blocked.txt"), "utf8"));
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("chat command reads terminal prompts until exit", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-cli-chat-"));
  const stdout = createWritableCapture();

  try {
    const exitCode = await runCli([
      "chat",
      "--session-store",
      sessionStoreDirectory,
      "--mock-response",
      "chat done"
    ], {
      stdin: Readable.from([
        "/thread\n",
        "hello\n",
        "/exit\n"
      ]),
      stdout,
      stderr: createWritableCapture()
    });

    assert.equal(exitCode, 0);
    assert.match(stdout.text, /^[0-9a-f-]{36}/);
    assert.match(stdout.text, /chat done/);
  } finally {
    await rm(sessionStoreDirectory, {
      recursive: true,
      force: true
    });
  }
});

test("chat command supports json event output", async () => {
  const stdout = createWritableCapture();
  const exitCode = await runCli([
    "chat",
    "hello",
    "--json",
    "--mock-response",
    "json chat done"
  ], {
    stdin: Readable.from(["/exit\n"]),
    stdout,
    stderr: createWritableCapture()
  });

  assert.equal(exitCode, 0);

  const events = stdout.text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events[0].type, "thread.started");
  assert.equal(events.at(-1).type, "turn.completed");
  assert.ok(events.some((event) => event.item?.role === "assistant"));
});

test("exec --dry-run-command --json emits command execution item events", async () => {
  const output = createWritableCapture();
  const exitCode = await runCli([
    "exec",
    "ignored prompt",
    "--json",
    "--dry-run-command",
    "npm test"
  ], {
    stdout: output,
    stderr: createWritableCapture()
  });

  assert.equal(exitCode, 0);

  const events = output.text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events[0].type, "item.started");
  assert.equal(events[0].item.type, "command_execution");
  assert.equal(events[0].item.command, "npm test");
  assert.equal(events[1].type, "item.completed");
  assert.equal(events[1].item.aggregated_output, "dry-run: npm test");
});

test("exec --dry-run-command human output writes command status to stderr", async () => {
  const stdout = createWritableCapture();
  const stderr = createWritableCapture();
  const exitCode = await runCli([
    "exec",
    "ignored prompt",
    "--dry-run-command",
    "npm test"
  ], {
    stdout,
    stderr
  });

  assert.equal(exitCode, 0);
  assert.equal(stdout.text, "");
  assert.match(stderr.text, /exec/);
  assert.match(stderr.text, /npm test/);
  assert.match(stderr.text, /dry-run: npm test/);
});

test("config default prints safe JSON defaults", async () => {
  const output = createWritableCapture();
  const exitCode = await runCli(["config", "default"], {
    stdout: output,
    stderr: createWritableCapture()
  });
  const config = JSON.parse(output.text);

  assert.equal(exitCode, 0);
  assert.equal(config.model.provider, "mock");
  assert.equal(config.runtime.realShellEnabled, false);
});

test("config inspect loads JSON config and applies CLI overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-js-cli-config-"));

  try {
    const configPath = join(dir, "config.json");
    const output = createWritableCapture();
    await writeFile(configPath, JSON.stringify({
      mockResponse: "from config"
    }), "utf8");

    const exitCode = await runCli([
      "config",
      "inspect",
      "--config",
      configPath,
      "--mock-response",
      "from cli"
    ], {
      stdout: output,
      stderr: createWritableCapture()
    });
    const config = JSON.parse(output.text);

    assert.equal(exitCode, 0);
    assert.equal(config.mockResponse, "from cli");
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
  }
});

test("config inspect redacts model provider secrets", async () => {
  const output = createWritableCapture();
  const exitCode = await runCli([
    "config",
    "inspect",
    "--model-provider",
    "deepseek",
    "--model",
    "v4-pro",
    "--model-api-key",
    "secret-test-key",
    "--model-header",
    "Authorization=Bearer header-secret"
  ], {
    stdout: output,
    stderr: createWritableCapture()
  });
  const config = JSON.parse(output.text);

  assert.equal(exitCode, 0);
  assert.equal(config.model.provider, "deepseek");
  assert.equal(config.model.options.model, "v4-pro");
  assert.equal(config.model.options.apiKey, "[redacted]");
  assert.equal(config.model.headers.Authorization, "[redacted]");
  assert.doesNotMatch(output.text, /secret-test-key/);
  assert.doesNotMatch(output.text, /header-secret/);
});

test("app-server smoke runs an in-process turn", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-cli-app-server-"));

  try {
    const output = createWritableCapture();
    const exitCode = await runCli([
      "app-server",
      "smoke",
      "hello",
      "--session-store",
      sessionStoreDirectory
    ], {
      stdout: output,
      stderr: createWritableCapture()
    });
    const result = JSON.parse(output.text);

    assert.equal(exitCode, 0);
    assert.equal(result.initialized, true);
    assert.equal(result.turnStatus, "completed");
    assert.equal(typeof result.threadId, "string");
    assert.ok(result.notifications > 0);
  } finally {
    await rm(sessionStoreDirectory, {
      recursive: true,
      force: true
    });
  }
});

test("app-server stdio reads JSONL requests and writes JSONL responses", async () => {
  const stdout = createWritableCapture();
  const stderr = createWritableCapture();
  const stdin = Readable.from([
    JSON.stringify({
      method: "initialize",
      id: 1,
      params: {}
    }),
    "\n"
  ]);
  const exitCode = await runCli([
    "app-server",
    "stdio"
  ], {
    stdin,
    stdout,
    stderr
  });
  const messages = stdout.text.trim().split("\n").map((line) => JSON.parse(line));

  assert.equal(exitCode, 0);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 1);
  assert.equal(messages[0].result.userAgent, "codex-js-app-server/0.1.0");
  assert.equal(stderr.text, "");
});

test("thread CLI starts, lists, updates, forks, archives, and unarchives sessions", async () => {
  const sessionStoreDirectory = await mkdtemp(join(tmpdir(), "codex-js-cli-thread-"));

  try {
    const startedOutput = createWritableCapture();
    const startedExit = await runCli([
      "thread",
      "start",
      "--session-store",
      sessionStoreDirectory
    ], {
      stdout: startedOutput,
      stderr: createWritableCapture()
    });
    const started = JSON.parse(startedOutput.text);

    assert.equal(startedExit, 0);
    assert.equal(typeof started.thread.id, "string");

    const runOutput = createWritableCapture();
    await runCli([
      "exec",
      "hello",
      "--json",
      "--resume",
      started.thread.id,
      "--session-store",
      sessionStoreDirectory
    ], {
      stdout: runOutput,
      stderr: createWritableCapture()
    });

    const listOutput = createWritableCapture();
    const listExit = await runCli([
      "thread",
      "list",
      "--session-store",
      sessionStoreDirectory
    ], {
      stdout: listOutput,
      stderr: createWritableCapture()
    });
    const listed = JSON.parse(listOutput.text);

    assert.equal(listExit, 0);
    assert.equal(listed.threads.some((thread) => thread.id === started.thread.id), true);

    const metadataOutput = createWritableCapture();
    const metadataExit = await runCli([
      "thread",
      "metadata",
      started.thread.id,
      "--metadata",
      "{\"title\":\"cli title\"}",
      "--session-store",
      sessionStoreDirectory
    ], {
      stdout: metadataOutput,
      stderr: createWritableCapture()
    });
    const metadata = JSON.parse(metadataOutput.text);

    assert.equal(metadataExit, 0);
    assert.equal(metadata.thread.metadata.title, "cli title");

    const forkOutput = createWritableCapture();
    const forkExit = await runCli([
      "thread",
      "fork",
      started.thread.id,
      "--session-store",
      sessionStoreDirectory
    ], {
      stdout: forkOutput,
      stderr: createWritableCapture()
    });
    const forked = JSON.parse(forkOutput.text);

    assert.equal(forkExit, 0);
    assert.notEqual(forked.thread.id, started.thread.id);

    const archiveOutput = createWritableCapture();
    const archiveExit = await runCli([
      "thread",
      "archive",
      started.thread.id,
      "--session-store",
      sessionStoreDirectory
    ], {
      stdout: archiveOutput,
      stderr: createWritableCapture()
    });

    assert.equal(archiveExit, 0);

    const archivedListOutput = createWritableCapture();
    await runCli([
      "thread",
      "list",
      "--archived",
      "--session-store",
      sessionStoreDirectory
    ], {
      stdout: archivedListOutput,
      stderr: createWritableCapture()
    });
    const archivedList = JSON.parse(archivedListOutput.text);

    assert.equal(archivedList.threads.some((thread) => thread.id === started.thread.id), true);

    const unarchiveOutput = createWritableCapture();
    const unarchiveExit = await runCli([
      "thread",
      "unarchive",
      started.thread.id,
      "--session-store",
      sessionStoreDirectory
    ], {
      stdout: unarchiveOutput,
      stderr: createWritableCapture()
    });

    assert.equal(unarchiveExit, 0);
  } finally {
    await rm(sessionStoreDirectory, {
      recursive: true,
      force: true
    });
  }
});

test("thread CLI returns an error when thread id is missing", async () => {
  const stderr = createWritableCapture();
  const exitCode = await runCli([
    "thread",
    "read"
  ], {
    stdout: createWritableCapture(),
    stderr
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.text, /Missing thread id/);
});

function createWritableCapture() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    }
  };
}
