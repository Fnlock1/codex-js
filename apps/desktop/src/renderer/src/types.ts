import type {
  GitBranch,
  GitFileDiff,
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

export interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  children: TreeNode[];
}

export interface TreeRow extends TreeNode {
  level: number;
}

export interface OpenTab {
  path: string;
  label: string;
  content: string;
  savedContent: string;
  isDirty: boolean;
}

export interface TerminalLine {
  id: string;
  text: string;
  tone?: "normal" | "muted" | "success" | "error";
}

export type BottomPanelTab = "problems" | "output" | "terminal";

export interface DiagnosticProblem {
  id: string;
  path: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
}

export interface PaletteCommand {
  id: string;
  title: string;
  detail: string;
  shortcut?: string;
}

export type ActivityId = "files" | "search" | "source" | "run" | "extensions";

export type SearchMatch = WorkspaceSearchMatch;
export type GitStatus = GitStatusSummary;
export type GitDiff = GitFileDiff;
export type GitBranchInfo = GitBranch;
export type ShellResult = ShellCommandResult;
