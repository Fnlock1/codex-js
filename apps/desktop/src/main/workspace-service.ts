import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import type {
  GitBranch,
  GitCommitResult,
  GitFileDiff,
  GitStatusFile,
  GitStatusSummary,
  ShellCommandResult,
  WorkspaceSearchMatch
} from "@qoder-open/shared";

export interface WorkspaceEntry {
  path: string;
  kind: "file" | "directory";
}

export interface WorkspaceSnapshot {
  cwd: string;
  name: string;
  files: WorkspaceEntry[];
}

export interface ReadFileResult {
  path: string;
  content: string;
}

export interface WriteFileResult {
  path: string;
  bytes: number;
}

const execFileAsync = promisify(execFile);
const maxFileSize = 1024 * 1024;
const commandTimeoutMs = 120_000;
const cwdMarkerPrefix = "__QODER_CWD__=";
const ignoredGlobs = [
  "**/node_modules",
  "**/node_modules/**",
  "**/dist",
  "**/dist/**",
  "**/out",
  "**/out/**",
  "**/.git",
  "**/.git/**",
  "**/*.tsbuildinfo"
];

export class WorkspaceService {
  private currentWorkspace: string;
  private terminalCwd: string;

  constructor(initialCwd: string) {
    this.currentWorkspace = resolve(initialCwd);
    this.terminalCwd = this.currentWorkspace;
  }

  get cwd(): string {
    return this.currentWorkspace;
  }

  setWorkspace(cwd: string): void {
    this.currentWorkspace = resolve(cwd);
    this.terminalCwd = this.currentWorkspace;
  }

  isInsideWorkspace(filePath: string): boolean {
    const resolved = resolve(filePath);
    const rel = relative(this.currentWorkspace, resolved);
    return !rel.startsWith("..") && !isAbsolute(rel);
  }

  toWorkspaceRelativePath(filePath: string): string {
    if (!this.isInsideWorkspace(filePath)) {
      throw new Error(`Path escapes workspace: ${filePath}`);
    }

    return relative(this.currentWorkspace, resolve(filePath)).replace(/\\/g, "/");
  }

  async openExternalFileAsWorkspace(filePath: string): Promise<{
    snapshot: WorkspaceSnapshot;
    filePath: string;
  }> {
    const resolved = resolve(filePath);
    const info = await stat(resolved);

    if (!info.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    if (info.size > maxFileSize) {
      throw new Error(`File is larger than ${maxFileSize / 1024 / 1024}MB: ${filePath}`);
    }

    this.setWorkspace(dirname(resolved));

    return {
      snapshot: await this.snapshot(),
      filePath: basename(resolved)
    };
  }

  async snapshot(cwd = this.currentWorkspace): Promise<WorkspaceSnapshot> {
    const entries = await fg(["**/*"], {
      cwd,
      dot: true,
      ignore: ignoredGlobs,
      markDirectories: true,
      onlyFiles: false,
      unique: true
    });

    const files = entries
      .map<WorkspaceEntry>((entry) => ({
        path: entry.replace(/\/$/, ""),
        kind: entry.endsWith("/") ? "directory" : "file"
      }))
      .sort((a, b) => {
        if (a.kind !== b.kind) {
          return a.kind === "directory" ? -1 : 1;
        }

        return a.path.localeCompare(b.path);
      });

    return {
      cwd,
      name: basename(cwd) || cwd,
      files
    };
  }

  resolveInsideWorkspace(userPath: string): string {
    const resolved = isAbsolute(userPath) ? userPath : resolve(this.currentWorkspace, userPath);
    const rel = relative(this.currentWorkspace, resolved);

    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path escapes workspace: ${userPath}`);
    }

    return resolved;
  }

  async readFile(filePath: string): Promise<ReadFileResult> {
    const resolved = this.resolveInsideWorkspace(filePath);
    const info = await stat(resolved);

    if (!info.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    if (info.size > maxFileSize) {
      throw new Error(`File is larger than ${maxFileSize / 1024 / 1024}MB: ${filePath}`);
    }

    return {
      path: filePath,
      content: await readFile(resolved, "utf8")
    };
  }

  async writeFile(filePath: string, content: string): Promise<WriteFileResult> {
    const resolved = this.resolveInsideWorkspace(filePath);
    const bytes = Buffer.byteLength(content, "utf8");

    if (bytes > maxFileSize) {
      throw new Error(`File is larger than ${maxFileSize / 1024 / 1024}MB: ${filePath}`);
    }

    try {
      const info = await stat(resolved);

      if (info.isDirectory()) {
        throw new Error(`Not a file: ${filePath}`);
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }

    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf8");

    return {
      path: filePath,
      bytes
    };
  }

  async saveFileAsAbsolute(filePath: string, content: string): Promise<WriteFileResult> {
    const resolved = resolve(filePath);
    const bytes = Buffer.byteLength(content, "utf8");

    if (bytes > maxFileSize) {
      throw new Error(`File is larger than ${maxFileSize / 1024 / 1024}MB: ${filePath}`);
    }

    try {
      const info = await stat(resolved);

      if (info.isDirectory()) {
        throw new Error(`Not a file: ${filePath}`);
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }

    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf8");

    if (this.isInsideWorkspace(resolved)) {
      return {
        path: this.toWorkspaceRelativePath(resolved),
        bytes
      };
    }

    this.setWorkspace(dirname(resolved));

    return {
      path: basename(resolved),
      bytes
    };
  }

  async search(query: string, glob?: string): Promise<WorkspaceSearchMatch[]> {
    const trimmed = query.trim();

    if (!trimmed) {
      return [];
    }

    const args = [
      "--line-number",
      "--hidden",
      "--no-messages",
      "--color",
      "never",
      "--max-filesize",
      "1M",
      "--glob",
      "!node_modules",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!dist",
      "--glob",
      "!dist/**",
      "--glob",
      "!out",
      "--glob",
      "!out/**",
      "--glob",
      "!.git",
      "--glob",
      "!.git/**"
    ];

    if (glob?.trim()) {
      args.push("--glob", glob.trim());
    }

    args.push(trimmed, ".");

    try {
      const { stdout } = await execFileAsync("rg", args, {
        cwd: this.currentWorkspace,
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 1024 * 1024 * 4
      });

      return parseRipgrepOutput(stdout);
    } catch (error) {
      if (isCommandExit(error, 1)) {
        return [];
      }

      throw error;
    }
  }

  async gitStatus(): Promise<GitStatusSummary> {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], {
        cwd: this.currentWorkspace,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      });

      return parseGitStatus(stdout);
    } catch {
      return {
        clean: true,
        files: [],
        raw: "Git status is not available for this workspace."
      };
    }
  }

  async gitDiff(filePath: string): Promise<GitFileDiff> {
    const path = this.toGitRelativePath(filePath);
    const [unstaged, staged] = await Promise.all([
      this.gitOutput(["diff", "--", path]),
      this.gitOutput(["diff", "--staged", "--", path])
    ]);
    const fallbackUntrackedDiff = !unstaged.trim() && !staged.trim() && await this.isUntrackedGitPath(path)
      ? await this.untrackedFileDiff(path)
      : "";

    return {
      path,
      staged,
      unstaged: unstaged || fallbackUntrackedDiff
    };
  }

  async gitStage(filePath: string): Promise<GitStatusSummary> {
    const path = this.toGitRelativePath(filePath);
    await this.gitOutput(["add", "--", path]);
    return this.gitStatus();
  }

  async gitStageAll(): Promise<GitStatusSummary> {
    await this.gitOutput(["add", "--all"]);
    return this.gitStatus();
  }

  async gitUnstage(filePath: string): Promise<GitStatusSummary> {
    const path = this.toGitRelativePath(filePath);
    await this.gitOutput(["restore", "--staged", "--", path]);
    return this.gitStatus();
  }

  async gitDiscard(filePath: string): Promise<GitStatusSummary> {
    const path = this.toGitRelativePath(filePath);

    if (await this.isUntrackedGitPath(path)) {
      await this.gitOutput(["clean", "-f", "--", path]);
    } else {
      await this.tryGitOutput(["restore", "--staged", "--", path]);

      if (await this.isUntrackedGitPath(path)) {
        await this.gitOutput(["clean", "-f", "--", path]);
      } else {
        await this.gitOutput(["restore", "--worktree", "--", path]);
      }
    }

    return this.gitStatus();
  }

  async gitCommit(message: string): Promise<GitCommitResult> {
    const trimmed = message.trim();

    if (!trimmed) {
      return {
        ok: false,
        output: "Commit message is required."
      };
    }

    try {
      const output = await this.gitOutput(["commit", "-m", trimmed]);

      return {
        ok: true,
        output: output || "Commit created.",
        commit: parseCommitHash(output)
      };
    } catch (error) {
      const err = error as Error & {
        stdout?: string;
        stderr?: string;
      };

      return {
        ok: false,
        output: [err.stdout?.trim(), err.stderr?.trim(), err.message].filter(Boolean).join("\n")
      };
    }
  }

  async gitBranches(): Promise<GitBranch[]> {
    try {
      const output = await this.gitOutput(["branch", "--format=%(HEAD)%09%(refname:short)"]);

      return output
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [head, name] = line.split("\t");

          return {
            name: name || line.trim().replace(/^\*\s*/, ""),
            current: head.trim() === "*"
          };
        });
    } catch {
      return [];
    }
  }

  async runCommand(command: string): Promise<ShellCommandResult> {
    const trimmed = command.trim();

    if (!trimmed) {
      return {
        ok: false,
        output: "Command is required.",
        exitCode: 1
      };
    }

    return process.platform === "win32"
      ? this.runPowerShellCommand(trimmed)
      : this.runPosixShellCommand(trimmed);
  }

  private async runPowerShellCommand(command: string): Promise<ShellCommandResult> {
    const wrappedCommand = [
      "$ErrorActionPreference = 'Continue'",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
      "$OutputEncoding = [Console]::OutputEncoding",
      "& {",
      command,
      "}",
      "$qoderCommandSucceeded = $?",
      "$qoderNativeExitCode = $LASTEXITCODE",
      `Write-Output "${cwdMarkerPrefix}$(Get-Location)"`,
      "if ($null -ne $qoderNativeExitCode) { exit $qoderNativeExitCode }",
      "if ($qoderCommandSucceeded) { exit 0 }",
      "exit 1"
    ].join("; ");

    try {
      const { stdout, stderr } = await execFileAsync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          wrappedCommand
        ],
        {
          cwd: this.terminalCwd,
          windowsHide: true,
          timeout: commandTimeoutMs,
          maxBuffer: 1024 * 1024 * 8,
          encoding: "utf8"
        }
      );

      const parsed = parseCommandOutput(stdout, stderr);
      this.terminalCwd = parsed.cwd ?? this.terminalCwd;

      return {
        ok: true,
        output: parsed.output || "Command completed with no output.",
        exitCode: 0,
        cwd: this.terminalCwd
      };
    } catch (error) {
      const err = error as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      const parsed = parseCommandOutput(err.stdout ?? "", err.stderr ?? "");
      this.terminalCwd = parsed.cwd ?? this.terminalCwd;

      return {
        ok: false,
        output: parsed.output || err.message,
        exitCode: typeof err.code === "number" ? err.code : 1,
        cwd: this.terminalCwd
      };
    }
  }

  private async runPosixShellCommand(command: string): Promise<ShellCommandResult> {
    const wrappedCommand = `${command}
qoder_exit_code=$?
printf '\\n${cwdMarkerPrefix}%s\\n' "$PWD"
exit "$qoder_exit_code"`;

    try {
      const { stdout, stderr } = await execFileAsync("sh", ["-lc", wrappedCommand], {
        cwd: this.terminalCwd,
        windowsHide: true,
        timeout: commandTimeoutMs,
        maxBuffer: 1024 * 1024 * 8,
        encoding: "utf8"
      });
      const parsed = parseCommandOutput(stdout, stderr);
      this.terminalCwd = parsed.cwd ?? this.terminalCwd;

      return {
        ok: true,
        output: parsed.output || "Command completed with no output.",
        exitCode: 0,
        cwd: this.terminalCwd
      };
    } catch (error) {
      const err = error as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      const parsed = parseCommandOutput(err.stdout ?? "", err.stderr ?? "");
      this.terminalCwd = parsed.cwd ?? this.terminalCwd;

      return {
        ok: false,
        output: parsed.output || err.message,
        exitCode: typeof err.code === "number" ? err.code : 1,
        cwd: this.terminalCwd
      };
    }
  }

  private toGitRelativePath(filePath: string): string {
    this.resolveInsideWorkspace(filePath);
    return filePath.replace(/\\/g, "/");
  }

  private async gitOutput(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.currentWorkspace,
      windowsHide: true,
      timeout: commandTimeoutMs,
      maxBuffer: 1024 * 1024 * 8,
      encoding: "utf8"
    });

    return stdout;
  }

  private async tryGitOutput(args: string[]): Promise<string> {
    try {
      return await this.gitOutput(args);
    } catch {
      return "";
    }
  }

  private async isUntrackedGitPath(path: string): Promise<boolean> {
    try {
      const output = await this.gitOutput(["status", "--short", "--", path]);
      return output
        .split(/\r?\n/)
        .filter(Boolean)
        .some((line) => line.startsWith("?? "));
    } catch {
      return false;
    }
  }

  private async untrackedFileDiff(path: string): Promise<string> {
    try {
      const { content } = await this.readFile(path);
      const additions = content.split(/\r?\n/).map((line) => `+${line}`).join("\n");

      return [
        `diff --git a/${path} b/${path}`,
        "new file mode 100644",
        "index 0000000..0000000",
        "--- /dev/null",
        `+++ b/${path}`,
        "@@",
        additions
      ].join("\n");
    } catch {
      return "Untracked file. Stage it to include it in the next commit.";
    }
  }
}

function parseCommandOutput(stdout: string, stderr: string): {
  output: string;
  cwd?: string;
} {
  const lines = stdout.split(/\r?\n/);
  let markerIndex = -1;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.startsWith(cwdMarkerPrefix)) {
      markerIndex = index;
      break;
    }
  }

  const cwd = markerIndex >= 0 ? lines[markerIndex]?.slice(cwdMarkerPrefix.length).trim() : undefined;
  const visibleStdout = markerIndex >= 0
    ? [...lines.slice(0, markerIndex), ...lines.slice(markerIndex + 1)].join("\n")
    : stdout;
  const output = [visibleStdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");

  return {
    output,
    cwd
  };
}

function parseRipgrepOutput(output: string): WorkspaceSearchMatch[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = /^(.+?):(\d+):(.*)$/.exec(line);
      if (!match) {
        return undefined;
      }

      return {
        path: match[1],
        line: Number(match[2]),
        text: match[3]
      };
    })
    .filter((match): match is WorkspaceSearchMatch => Boolean(match));
}

function parseGitStatus(output: string): GitStatusSummary {
  const lines = output.split(/\r?\n/).filter(Boolean);
  let branch: string | undefined;
  const files: GitStatusFile[] = [];

  if (lines.some((line) => line.startsWith("fatal:"))) {
    return {
      clean: true,
      files: [],
      raw: output
    };
  }

  for (const line of lines) {
    if (line.startsWith("## ")) {
      branch = line.slice(3).split("...")[0];
      continue;
    }

    files.push({
      index: line.slice(0, 1).trim() || " ",
      workingTree: line.slice(1, 2).trim() || " ",
      path: normalizeGitStatusPath(line.slice(3))
    });
  }

  return {
    branch,
    clean: files.length === 0,
    files,
    raw: output
  };
}

function normalizeGitStatusPath(path: string): string {
  const renameArrow = " -> ";

  if (path.includes(renameArrow)) {
    return path.slice(path.lastIndexOf(renameArrow) + renameArrow.length);
  }

  return path;
}

function parseCommitHash(output: string): string | undefined {
  return /\[[^\s\]]+\s+([0-9a-f]{6,40})\]/i.exec(output)?.[1];
}

function isCommandExit(error: unknown, code: number): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
