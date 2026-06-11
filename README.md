# Qoder Open

Qoder Open is now a lightweight Electron + Vue + Monaco desktop code editor.

The desktop app keeps the normal editor features: workspace file explorer, file
editing, search, Git panel, integrated PTY terminal, language service
integration, diagnostics, formatting, rename, code actions, and a lightweight
project symbol index.

## What Is Included

- `apps/desktop`: Electron + Vite + Vue desktop editor.
- `packages/shared`: shared editor, workspace, Git, terminal, language service, and project index types.

## Quick Start

```bash
pnpm install
pnpm --filter @qoder-open/desktop dev
```

## Build

```bash
pnpm --filter @qoder-open/shared check
pnpm --filter @qoder-open/desktop check
pnpm --filter @qoder-open/desktop build
```

## Current Scope

The desktop app supports:

- Opening a workspace folder or external file.
- Editing and saving files through Monaco.
- Workspace search.
- Git status, diff, stage, unstage, discard, commit, and branch display.
- Integrated terminal backed by `node-pty`.
- Vue, TypeScript, Python, Rust, and Go language service hooks where the relevant servers are available.
- Problems panel and project symbol search.

The app intentionally does not include AI chat, agent orchestration, model providers, tool-call loops, approval flows, MCP, or CLI agent commands.
