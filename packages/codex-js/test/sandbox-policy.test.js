/**
 * 中文模块说明：test/sandbox-policy.test.js
 *
 * Node 内置测试套件，覆盖 codex-js 的核心运行时和工具行为。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SANDBOX_ACCESS_TYPES,
  SANDBOX_DECISIONS,
  SANDBOX_MODES,
  SandboxPolicy,
  assertSandboxAllowed,
  classifyCommandRisk,
  createSandboxPolicyFromProfile,
  defaultPermissionProfileForSandboxMode,
  normalizeSandboxPath,
  pathIsInsideRoot
} from "../src/index.js";

test("SandboxPolicy read-only allows reads but denies writes and exec", () => {
  const policy = new SandboxPolicy({
    mode: SANDBOX_MODES.READ_ONLY,
    workingDirectory: "/workspace"
  });

  assert.equal(policy.checkPath("/workspace/README.md").decision, SANDBOX_DECISIONS.ALLOW);
  assert.equal(
    policy.checkPath("/workspace/README.md", SANDBOX_ACCESS_TYPES.WRITE).decision,
    SANDBOX_DECISIONS.DENY
  );
  assert.equal(policy.checkExec({
    cwd: "/workspace"
  }).decision, SANDBOX_DECISIONS.DENY);
});

test("SandboxPolicy workspace-write allows writes only inside workspace", () => {
  const policy = new SandboxPolicy({
    mode: SANDBOX_MODES.WORKSPACE_WRITE,
    workingDirectory: "/workspace"
  });

  assert.equal(
    policy.checkPath("/workspace/file.txt", SANDBOX_ACCESS_TYPES.WRITE).decision,
    SANDBOX_DECISIONS.ALLOW
  );
  assert.equal(
    policy.checkPath("/outside/file.txt", SANDBOX_ACCESS_TYPES.WRITE).decision,
    SANDBOX_DECISIONS.DENY
  );
  assert.equal(policy.checkExec({
    cwd: "/workspace"
  }).decision, SANDBOX_DECISIONS.ALLOW);
  assert.equal(policy.checkExec({
    cwd: "/outside"
  }).decision, SANDBOX_DECISIONS.DENY);
});

test("SandboxPolicy blocks unsafe env overrides and classifies command risk", () => {
  const policy = new SandboxPolicy({
    mode: SANDBOX_MODES.WORKSPACE_WRITE,
    workingDirectory: "/workspace",
    allowedEnvKeys: ["SAFE_FLAG"]
  });

  assert.equal(policy.checkEnv({
    SAFE_FLAG: "1"
  }).decision, SANDBOX_DECISIONS.ALLOW);
  assert.equal(policy.checkEnv({
    OPENAI_API_KEY: "secret"
  }).decision, SANDBOX_DECISIONS.DENY);
  assert.equal(policy.checkEnv({
    OTHER_FLAG: "1"
  }).metadata.blocked_keys[0], "OTHER_FLAG");
  assert.equal(classifyCommandRisk("rm -rf dist"), "destructive");
  assert.equal(classifyCommandRisk("npm install"), "network");
  assert.equal(classifyCommandRisk("npm test"), "normal");
});

test("SandboxPolicy checkExec denies blocked env overrides", () => {
  const policy = new SandboxPolicy({
    mode: SANDBOX_MODES.WORKSPACE_WRITE,
    workingDirectory: "/workspace"
  });
  const decision = policy.checkExec({
    command: "npm test",
    cwd: "/workspace",
    env: {
      GITHUB_TOKEN: "secret"
    }
  });

  assert.equal(decision.decision, SANDBOX_DECISIONS.DENY);
  assert.match(decision.reason, /environment keys blocked/);
  assert.deepEqual(decision.metadata.env.blocked_keys, ["GITHUB_TOKEN"]);
});

test("SandboxPolicy blocks network-risk commands unless network is allowed", () => {
  const blocked = new SandboxPolicy({
    mode: SANDBOX_MODES.WORKSPACE_WRITE,
    workingDirectory: "/workspace"
  });
  const allowed = new SandboxPolicy({
    mode: SANDBOX_MODES.WORKSPACE_WRITE,
    workingDirectory: "/workspace",
    networkAllowed: true
  });

  assert.equal(blocked.checkExec({
    command: "npm install",
    cwd: "/workspace"
  }).decision, SANDBOX_DECISIONS.DENY);
  assert.equal(blocked.checkExec({
    command: "npm install",
    cwd: "/workspace"
  }).metadata.command_risk, "network");
  assert.equal(allowed.checkExec({
    command: "npm install",
    cwd: "/workspace"
  }).decision, SANDBOX_DECISIONS.ALLOW);
});

test("SandboxPolicy danger-full-access allows writes and network", () => {
  const policy = new SandboxPolicy({
    mode: SANDBOX_MODES.DANGER_FULL_ACCESS,
    workingDirectory: "/workspace"
  });

  assert.equal(
    policy.checkPath("/outside/file.txt", SANDBOX_ACCESS_TYPES.WRITE).decision,
    SANDBOX_DECISIONS.ALLOW
  );
  assert.equal(policy.checkNetwork().decision, SANDBOX_DECISIONS.ALLOW);
});

test("sandbox helpers normalize paths and profiles", () => {
  assert.equal(pathIsInsideRoot("/workspace/src/app.js", "/workspace"), true);
  assert.equal(pathIsInsideRoot("/outside/app.js", "/workspace"), false);
  assert.match(normalizeSandboxPath("src/app.js", "/workspace").replace(/\\/g, "/"), /\/workspace\/src\/app\.js$/);
  assert.deepEqual(defaultPermissionProfileForSandboxMode(SANDBOX_MODES.WORKSPACE_WRITE), {
    approvalPolicy: "on-request",
    sandboxMode: "workspace-write"
  });
  assert.equal(createSandboxPolicyFromProfile({
    sandboxMode: SANDBOX_MODES.WORKSPACE_WRITE
  }, {
    workingDirectory: "/workspace"
  }).mode, SANDBOX_MODES.WORKSPACE_WRITE);
});

test("assertSandboxAllowed throws for denied decisions", () => {
  const policy = new SandboxPolicy({
    mode: SANDBOX_MODES.READ_ONLY,
    workingDirectory: "/workspace"
  });

  assert.throws(
    () => assertSandboxAllowed(policy.checkPath("/workspace/file.txt", SANDBOX_ACCESS_TYPES.WRITE)),
    /write outside sandbox roots/
  );
});
