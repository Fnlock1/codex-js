import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SANDBOX_ACCESS_TYPES,
  SandboxPolicy,
  assertSandboxAllowed
} from "./policy.js";
import {
  SANDBOX_RUNTIME_TYPES,
  SandboxRuntime
} from "./runtime.js";

export class LocalSandboxRuntime extends SandboxRuntime {
  constructor(options = {}) {
    super({
      ...options,
      type: SANDBOX_RUNTIME_TYPES.LOCAL
    });
    this.policy = options.policy ?? options.sandboxPolicy ?? new SandboxPolicy({
      mode: options.mode ?? options.sandboxMode ?? options.sandbox_mode,
      workingDirectory: this.workingDirectory,
      readRoots: options.readRoots,
      writeRoots: options.writeRoots,
      networkAllowed: options.networkAllowed,
      execAllowed: options.execAllowed,
      allowedEnvKeys: options.allowedEnvKeys,
      blockedEnvKeys: options.blockedEnvKeys
    });
  }

  async createSession(options = {}) {
    const session = await super.createSession({
      ...options,
      metadata: {
        ...(options.metadata ?? {}),
        sandboxMode: this.policy.mode,
        readRoots: [...this.policy.readRoots],
        writeRoots: [...this.policy.writeRoots],
        networkAllowed: this.policy.networkAllowed
      }
    });

    return session;
  }

  async runCommand(session, request = {}) {
    const decision = this.policy.checkExec({
      command: request.command,
      argv: request.argv,
      cwd: request.cwd ?? session?.workingDirectory ?? this.workingDirectory,
      env: request.env
    });

    assertSandboxAllowed(decision);

    return {
      runtimeType: this.type,
      sessionId: session?.id ?? null,
      allowed: true,
      decision,
      request: {
        command: request.command ?? null,
        argv: request.argv ?? null,
        cwd: request.cwd ?? session?.workingDirectory ?? this.workingDirectory
      }
    };
  }

  async readFile(session, filePath) {
    const resolved = this.resolveSessionPath(session, filePath);

    assertSandboxAllowed(this.policy.checkRead(resolved));

    return await readFile(resolved, "utf8");
  }

  async writeFile(session, filePath, contents) {
    const resolved = this.resolveSessionPath(session, filePath);

    assertSandboxAllowed(this.policy.checkWrite(resolved));
    await writeFile(resolved, String(contents ?? ""), "utf8");

    return {
      path: resolved,
      bytes: Buffer.byteLength(String(contents ?? ""), "utf8")
    };
  }

  async listFiles(session, directoryPath = ".") {
    const resolved = this.resolveSessionPath(session, directoryPath);

    assertSandboxAllowed(this.policy.checkPath(resolved, SANDBOX_ACCESS_TYPES.READ));

    const entries = await readdir(resolved, {
      withFileTypes: true
    });

    return entries.map((entry) => ({
      name: entry.name,
      path: path.join(resolved, entry.name),
      type: entry.isDirectory() ? "directory" : "file"
    }));
  }

  resolveSessionPath(session, targetPath = ".") {
    const base = session?.workingDirectory ?? this.workingDirectory;
    const value = String(targetPath ?? ".");

    return path.resolve(path.isAbsolute(value) ? value : path.join(base, value));
  }
}

export function createLocalSandboxRuntime(options = {}) {
  return new LocalSandboxRuntime(options);
}
