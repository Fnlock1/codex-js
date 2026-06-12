import path from "node:path";

export const SANDBOX_RUNTIME_TYPES = Object.freeze({
  LOCAL: "local",
  DOCKER: "docker"
});

export const SANDBOX_SESSION_STATUSES = Object.freeze({
  CREATED: "created",
  DISPOSED: "disposed"
});

export class SandboxRuntime {
  constructor(options = {}) {
    this.type = normalizeSandboxRuntimeType(options.type);
    this.workingDirectory = path.resolve(options.workingDirectory ?? process.cwd());
  }

  async createSession(options = {}) {
    return createSandboxSessionRecord({
      runtimeType: this.type,
      workingDirectory: options.workingDirectory ?? this.workingDirectory,
      metadata: options.metadata
    });
  }

  async runCommand(_session, _request) {
    throw new Error("SandboxRuntime.runCommand() must be implemented by a subclass.");
  }

  async readFile(_session, _filePath) {
    throw new Error("SandboxRuntime.readFile() must be implemented by a subclass.");
  }

  async writeFile(_session, _filePath, _contents) {
    throw new Error("SandboxRuntime.writeFile() must be implemented by a subclass.");
  }

  async listFiles(_session, _directoryPath) {
    throw new Error("SandboxRuntime.listFiles() must be implemented by a subclass.");
  }

  async disposeSession(session) {
    return {
      ...session,
      status: SANDBOX_SESSION_STATUSES.DISPOSED,
      disposedAt: new Date().toISOString()
    };
  }
}

export function createSandboxSessionRecord(options = {}) {
  return {
    id: String(options.id ?? `sandbox_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`),
    runtimeType: normalizeSandboxRuntimeType(options.runtimeType ?? options.runtime_type),
    workingDirectory: path.resolve(options.workingDirectory ?? process.cwd()),
    status: options.status ?? SANDBOX_SESSION_STATUSES.CREATED,
    createdAt: options.createdAt ?? new Date().toISOString(),
    metadata: options.metadata && typeof options.metadata === "object" && !Array.isArray(options.metadata)
      ? { ...options.metadata }
      : {}
  };
}

export function normalizeSandboxRuntimeType(value) {
  const normalized = String(value ?? SANDBOX_RUNTIME_TYPES.LOCAL).trim().toLowerCase();

  if (normalized === SANDBOX_RUNTIME_TYPES.DOCKER) {
    return SANDBOX_RUNTIME_TYPES.DOCKER;
  }

  return SANDBOX_RUNTIME_TYPES.LOCAL;
}
