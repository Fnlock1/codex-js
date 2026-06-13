import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DOCKER_SANDBOX_ERROR_CODES,
  SANDBOX_RUNTIME_TYPES,
  SANDBOX_SESSION_STATUSES,
  SandboxRuntime,
  createDockerSandboxRuntime,
  createLocalSandboxRuntime,
  createSandboxSessionRecord,
  detectDockerSandboxAvailability,
  normalizeSandboxRuntimeType
} from "../src/index.js";

test("sandbox runtime helpers normalize runtime types and sessions", () => {
  const session = createSandboxSessionRecord({
    runtimeType: "docker",
    workingDirectory: "."
  });

  assert.equal(normalizeSandboxRuntimeType("docker"), SANDBOX_RUNTIME_TYPES.DOCKER);
  assert.equal(normalizeSandboxRuntimeType("unknown"), SANDBOX_RUNTIME_TYPES.LOCAL);
  assert.equal(session.runtimeType, SANDBOX_RUNTIME_TYPES.DOCKER);
  assert.equal(session.status, SANDBOX_SESSION_STATUSES.CREATED);
  assert.equal(path.isAbsolute(session.workingDirectory), true);
});

test("base SandboxRuntime creates and disposes sessions", async () => {
  const runtime = new SandboxRuntime({
    workingDirectory: "."
  });
  const session = await runtime.createSession();
  const disposed = await runtime.disposeSession(session);

  assert.equal(session.runtimeType, SANDBOX_RUNTIME_TYPES.LOCAL);
  assert.equal(disposed.status, SANDBOX_SESSION_STATUSES.DISPOSED);
  await assert.rejects(
    () => runtime.runCommand(session, {}),
    /must be implemented/
  );
});

test("LocalSandboxRuntime gates filesystem access through SandboxPolicy", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-js-local-sandbox-"));
  const outside = await mkdtemp(path.join(tmpdir(), "codex-js-local-sandbox-outside-"));

  try {
    await writeFile(path.join(dir, "README.md"), "hello", "utf8");
    const runtime = createLocalSandboxRuntime({
      workingDirectory: dir,
      sandboxMode: "workspace-write"
    });
    const session = await runtime.createSession();
    const entries = await runtime.listFiles(session, ".");
    const contents = await runtime.readFile(session, "README.md");
    const write = await runtime.writeFile(session, "created.txt", "created");

    assert.equal(entries.some((entry) => entry.name === "README.md"), true);
    assert.equal(contents, "hello");
    assert.equal(await readFile(path.join(dir, "created.txt"), "utf8"), "created");
    assert.equal(write.bytes, 7);
    await assert.rejects(
      () => runtime.writeFile(session, path.join(outside, "blocked.txt"), "blocked"),
      /write outside sandbox roots/
    );
  } finally {
    await rm(dir, {
      recursive: true,
      force: true
    });
    await rm(outside, {
      recursive: true,
      force: true
    });
  }
});

test("LocalSandboxRuntime checks command execution without running commands", async () => {
  const runtime = createLocalSandboxRuntime({
    workingDirectory: ".",
    sandboxMode: "workspace-write"
  });
  const session = await runtime.createSession();
  const result = await runtime.runCommand(session, {
    command: "node --version"
  });

  assert.equal(result.allowed, true);
  assert.equal(result.runtimeType, SANDBOX_RUNTIME_TYPES.LOCAL);
  assert.equal(result.request.command, "node --version");
});

test("Docker sandbox availability reports missing docker command", async () => {
  const availability = await detectDockerSandboxAvailability({
    dockerCommand: "definitely-missing-docker-command",
    timeoutMs: 100
  });

  assert.equal(availability.available, false);
  assert.equal(availability.runtimeType, SANDBOX_RUNTIME_TYPES.DOCKER);
  assert.equal(availability.reason, DOCKER_SANDBOX_ERROR_CODES.NOT_FOUND);
});

test("DockerSandboxRuntime is a phase-two detection runtime only", async () => {
  const runtime = createDockerSandboxRuntime({
    dockerCommand: "definitely-missing-docker-command",
    workingDirectory: "."
  });

  await assert.rejects(
    () => runtime.createSession({
      timeoutMs: 100
    }),
    /Docker sandbox unavailable/
  );
  await assert.rejects(
    () => runtime.runCommand(),
    /not implemented yet/
  );
});
