/**
 * 中文模块说明：test/exec-runner.test.js
 *
 * Node 内置测试套件，覆盖 codex-js 的核心运行时和工具行为。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  EXEC_POLICY_DECISIONS,
  APPROVAL_DECISIONS,
  ApprovalGate,
  ApprovalPolicy,
  ExecPermissionPolicy,
  ExecRunner,
  ITEM_TYPES,
  RealExecRuntime,
  SandboxPolicy,
  SANDBOX_MODES,
  createExecResult,
  createExecToolCallOutput,
  normalizeExecRequest
} from "../src/index.js";

test("normalizeExecRequest accepts command strings", () => {
  const request = normalizeExecRequest("npm test", {
    workingDirectory: "/workspace"
  });

  assert.deepEqual(request, {
    command: "npm test",
    cwd: "/workspace",
    timeoutMs: null,
    env: null
  });
});

test("ExecRunner emits dry-run command execution events", async () => {
  const runner = new ExecRunner({
    workingDirectory: "/workspace"
  });
  const events = [];

  for await (const event of runner.runDryCommand("npm test")) {
    events.push(event);
  }

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "item.started");
  assert.equal(events[0].item.type, ITEM_TYPES.COMMAND_EXECUTION);
  assert.equal(events[0].item.command, "npm test");
  assert.equal(events[0].item.status, "in_progress");
  assert.equal(events[1].type, "item.completed");
  assert.equal(events[1].item.status, "completed");
  assert.equal(events[1].item.exit_code, 0);
  assert.equal(events[1].item.aggregated_output, "dry-run: npm test");
});

test("ExecRunner can use an injected runtime", async () => {
  const runner = new ExecRunner({
    workingDirectory: "/workspace",
    runtime: {
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
            stdout: `custom: ${request.command}`,
            exitCode: 0
          }),
          executed: false,
          dryRun: true
        });
      }
    }
  });
  const events = [];

  for await (const event of runner.runDryCommand("npm test")) {
    events.push(event);
  }

  assert.equal(events.at(-1).item.aggregated_output, "custom: npm test");
});

test("ExecRunner can use RealExecRuntime and mark non-zero exits as failed", async () => {
  const script = await createTempExecScript("console.log('ok'); process.exit(3);");
  const runner = new ExecRunner({
    workingDirectory: process.cwd(),
    runtime: new RealExecRuntime({
      defaultTimeoutMs: 5000
    })
  });
  const events = [];

  try {
    for await (const event of runner.runCommand({
      command: [process.execPath, script.filePath],
      cwd: process.cwd()
    })) {
      events.push(event);
    }

    assert.equal(events.at(-1).item.status, "failed");
    assert.equal(events.at(-1).item.exit_code, 3);
    assert.match(events.at(-1).item.aggregated_output, /ok/);
  } finally {
    await script.cleanup();
  }
});

test("ExecRunner emits approval request when policy prompts", async () => {
  const runner = new ExecRunner({
    workingDirectory: "/workspace",
    permissionPolicy: new ExecPermissionPolicy()
  });
  const events = [];

  for await (const event of runner.runDryCommand("npm test")) {
    events.push(event);
  }

  const completed = events.at(-1);
  assert.equal(completed.item.status, "failed");
  assert.equal(completed.item.exit_code, 1);
  assert.equal(completed.item.approval_request.type, "exec_approval_request");
  assert.equal(completed.item.approval_request.command, "npm test");
});

test("ExecRunner can use ApprovalGate for prompt decisions", async () => {
  const runner = new ExecRunner({
    workingDirectory: "/workspace",
    approvalGate: new ApprovalGate({
      policy: new ApprovalPolicy({
        defaultDecision: APPROVAL_DECISIONS.PROMPT
      })
    })
  });
  const events = [];

  for await (const event of runner.runDryCommand("npm test")) {
    events.push(event);
  }

  const completed = events.at(-1);
  assert.equal(completed.item.status, "failed");
  assert.equal(completed.item.approval_request.approval.resource_type, "exec");
});

test("ExecRunner blocks forbidden policy decisions", async () => {
  const runner = new ExecRunner({
    workingDirectory: "/workspace",
    permissionPolicy: new ExecPermissionPolicy({
      prefixRules: [
        {
          prefix: ["npm"],
          decision: EXEC_POLICY_DECISIONS.FORBIDDEN
        }
      ]
    })
  });
  const events = [];

  for await (const event of runner.runDryCommand("npm test")) {
    events.push(event);
  }

  const completed = events.at(-1);
  assert.equal(completed.item.status, "failed");
  assert.equal(completed.item.approval_request, null);
  assert.equal(completed.item.aggregated_output, "dry-run blocked: forbidden");
});

test("ExecRunner blocks commands outside sandbox cwd", async () => {
  const runner = new ExecRunner({
    workingDirectory: "/workspace",
    sandboxPolicy: new SandboxPolicy({
      mode: SANDBOX_MODES.WORKSPACE_WRITE,
      workingDirectory: "/workspace"
    })
  });
  const events = [];

  for await (const event of runner.runDryCommand({
    command: "npm test",
    cwd: "/outside"
  })) {
    events.push(event);
  }

  const completed = events.at(-1);
  assert.equal(completed.item.status, "failed");
  assert.equal(completed.item.aggregated_output, "sandbox blocked: read outside sandbox roots");
});

/**
 * 创建 create temp exec script 相关数据。
 *
 * 这是异步流程，调用方需要等待 Promise 完成。
 *
 * @param {unknown} source - source 参数。
 * @returns {unknown} 返回处理后的结果。
 */
async function createTempExecScript(source) {
  const directory = await mkdtemp(path.join(tmpdir(), "codex-js-runner-"));
  const filePath = path.join(directory, "script.mjs");

  await writeFile(filePath, source, "utf8");

  return {
    filePath,
    /**
     * 处理 cleanup 相关逻辑。
     *
     * 这是异步流程，调用方需要等待 Promise 完成。
     * @returns {unknown} 返回处理后的结果。
     */
    async cleanup() {
      await rm(directory, {
        recursive: true,
        force: true
      });
    }
  };
}
