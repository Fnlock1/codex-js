import type { TreeNode, TreeRow, WorkspaceEntry } from "../types";

export function buildTree(entries: WorkspaceEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();

  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);

    parts.forEach((part, index) => {
      const nodePath = parts.slice(0, index + 1).join("/");
      const isLeaf = index === parts.length - 1;
      const kind = isLeaf ? entry.kind : "directory";

      if (byPath.has(nodePath)) {
        return;
      }

      const node: TreeNode = {
        name: part,
        path: nodePath,
        kind,
        children: []
      };

      byPath.set(nodePath, node);

      if (index === 0) {
        root.push(node);
        return;
      }

      byPath.get(parts.slice(0, index).join("/"))?.children.push(node);
    });
  }

  return sortNodes(root);
}

export function flattenTree(nodes: TreeNode[], expanded: Set<string>, level = 0): TreeRow[] {
  const rows: TreeRow[] = [];

  for (const node of nodes) {
    rows.push({ ...node, level });

    if (node.kind === "directory" && expanded.has(node.path)) {
      rows.push(...flattenTree(node.children, expanded, level + 1));
    }
  }

  return rows;
}

export function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
}

export function languageForPath(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: "JavaScript",
    jsx: "JavaScript React",
    ts: "TypeScript",
    tsx: "TypeScript React",
    vue: "Vue",
    json: "JSON",
    md: "Markdown",
    css: "CSS",
    html: "HTML",
    yaml: "YAML",
    yml: "YAML"
  };

  return map[extension ?? ""] ?? "plaintext";
}

export function badgeForPath(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: "JS",
    jsx: "JSX",
    ts: "TS",
    tsx: "TSX",
    vue: "V",
    json: "{}",
    md: "MD",
    css: "#",
    html: "<>",
    yaml: "YML",
    yml: "YML"
  };

  return map[extension ?? ""] ?? "";
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "directory" ? -1 : 1;
      }

      return a.name.localeCompare(b.name);
    })
    .map((node) => {
      node.children = sortNodes(node.children);
      return node;
    });
}
