# Architecture

Qoder Open is a desktop code editor built with Electron, Vue, Vite, Monaco, and TypeScript.

## Packages

| Package | Role |
| --- | --- |
| `apps/desktop` | Electron main/preload process and Vue renderer. |
| `packages/shared` | Shared TypeScript types for workspace, Git, terminal, language services, diagnostics, and project indexing. |

## Runtime Boundaries

- Electron main owns filesystem access, Git commands, PTY terminals, language server processes, and project indexing.
- Preload exposes a narrow `window.qoder` API to the renderer.
- Renderer owns the workbench UI, Monaco editor, tabs, panels, and local UI state.
- `packages/shared` must stay platform-neutral and only define serializable protocol/result types.

## Editor Capabilities

- Workspace explorer and file editing.
- Search over workspace files.
- Source control panel backed by Git.
- Integrated terminal backed by `node-pty`.
- Language service bridge for completions, hover, definitions, references, diagnostics, code actions, rename, formatting, and semantic tokens.
- Project index summary and symbol search.

## Removed Scope

AI chat, agent runtimes, model providers, model tool loops, approval orchestration, MCP adapters, and CLI agent commands have been removed from this project. Do not reintroduce them unless the product direction changes again.
