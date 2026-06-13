import { spawn } from "node:child_process";
import {
  SANDBOX_RUNTIME_TYPES,
  SandboxRuntime
} from "./runtime.js";

export const DOCKER_SANDBOX_ERROR_CODES = Object.freeze({
  NOT_FOUND: "docker_not_found",
  NOT_RUNNING: "docker_not_running",
  TIMEOUT: "docker_probe_timeout",
  UNSUPPORTED: "docker_runtime_not_implemented"
});

export class DockerSandboxRuntime extends SandboxRuntime {
  constructor(options = {}) {
    super({
      ...options,
      type: SANDBOX_RUNTIME_TYPES.DOCKER
    });
    this.dockerCommand = String(options.dockerCommand ?? "docker");
    this.image = String(options.image ?? options.containerImage ?? "node:22-bookworm");
    this.network = options.network ?? "none";
  }

  async createSession(options = {}) {
    const availability = await detectDockerSandboxAvailability({
      dockerCommand: this.dockerCommand,
      timeoutMs: options.timeoutMs
    });

    if (!availability.available) {
      const error = new Error(`Docker sandbox unavailable: ${availability.reason}`);
      error.code = availability.reason;
      error.details = availability;
      throw error;
    }

    return await super.createSession({
      ...options,
      metadata: {
        ...(options.metadata ?? {}),
        docker: availability,
        image: this.image,
        network: this.network
      }
    });
  }

  async runCommand() {
    throw createDockerRuntimeNotImplementedError("runCommand");
  }

  async readFile() {
    throw createDockerRuntimeNotImplementedError("readFile");
  }

  async writeFile() {
    throw createDockerRuntimeNotImplementedError("writeFile");
  }

  async listFiles() {
    throw createDockerRuntimeNotImplementedError("listFiles");
  }
}

export function createDockerSandboxRuntime(options = {}) {
  return new DockerSandboxRuntime(options);
}

export async function detectDockerSandboxAvailability(options = {}) {
  const dockerCommand = String(options.dockerCommand ?? "docker");
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 5000);
  const version = await runDockerProbe(dockerCommand, ["--version"], timeoutMs);

  if (!version.ok) {
    return {
      available: false,
      runtimeType: SANDBOX_RUNTIME_TYPES.DOCKER,
      command: dockerCommand,
      reason: version.reason,
      version: null,
      info: null,
      error: version.error
    };
  }

  const info = await runDockerProbe(dockerCommand, ["info", "--format", "{{json .ServerVersion}}"], timeoutMs);

  if (!info.ok) {
    return {
      available: false,
      runtimeType: SANDBOX_RUNTIME_TYPES.DOCKER,
      command: dockerCommand,
      reason: info.reason === DOCKER_SANDBOX_ERROR_CODES.NOT_FOUND
        ? DOCKER_SANDBOX_ERROR_CODES.NOT_FOUND
        : DOCKER_SANDBOX_ERROR_CODES.NOT_RUNNING,
      version: version.output.trim(),
      info: null,
      error: info.error
    };
  }

  return {
    available: true,
    runtimeType: SANDBOX_RUNTIME_TYPES.DOCKER,
    command: dockerCommand,
    reason: null,
    version: version.output.trim(),
    info: info.output.trim() || null,
    error: null
  };
}

function createDockerRuntimeNotImplementedError(operation) {
  const error = new Error(`DockerSandboxRuntime.${operation}() is not implemented yet. Phase 2 only detects Docker availability.`);

  error.code = DOCKER_SANDBOX_ERROR_CODES.UNSUPPORTED;
  return error;
}

function runDockerProbe(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill();
      resolve({
        ok: false,
        reason: DOCKER_SANDBOX_ERROR_CODES.TIMEOUT,
        output: "",
        error: `docker probe timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        reason: error.code === "ENOENT"
          ? DOCKER_SANDBOX_ERROR_CODES.NOT_FOUND
          : DOCKER_SANDBOX_ERROR_CODES.NOT_RUNNING,
        output: "",
        error: error.message
      });
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        reason: code === 0 ? null : DOCKER_SANDBOX_ERROR_CODES.NOT_RUNNING,
        output: Buffer.concat(stdout).toString("utf8"),
        error: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);

  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
