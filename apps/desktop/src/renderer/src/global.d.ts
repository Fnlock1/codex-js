import type { QoderDesktopApi } from "../../preload";

declare global {
  interface Window {
    qoder?: QoderDesktopApi;
  }
}

export interface WorkspaceEntry {
  path: string;
  kind: "file" | "directory";
}

export interface WorkspaceSnapshot {
  cwd: string;
  name: string;
  files: WorkspaceEntry[];
}
