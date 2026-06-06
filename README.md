# Qoder Open

Qoder Open is now a lightweight Electron + Vue + Monaco desktop code editor.

The desktop app keeps the normal editor features: workspace file explorer, file
editing, search, Git panel, integrated PTY terminal, language service
integration, diagnostics, formatting, rename, code actions, and a lightweight
project symbol index.

This repository also contains `packages/codex-js`, a standalone terminal-first
JavaScript agent runtime inspired by OpenAI Codex. It is intentionally separate
from the desktop editor: it is not wired into Electron/Vue/Monaco, does not read
`.env`, and has its own CLI/runtime/tool/sandbox documentation.

## What Is Included

- `apps/desktop`: Electron + Vite + Vue desktop editor.
- `packages/shared`: shared editor, workspace, Git, terminal, language service, and project index types.
- `packages/codex-js`: standalone pure ESM JavaScript terminal agent package.

## Quick Start

```bash
pnpm install
pnpm --filter @qoder-open/desktop dev
```

Run the standalone terminal agent package:

```bash
cd packages/codex-js
node ./bin/codex-js.js exec "hello"
node ./bin/codex-js.js exec "hello" --json-stream
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

Those agent capabilities live only in `packages/codex-js`. See
[`packages/codex-js/README.md`](packages/codex-js/README.md) for the terminal
agent architecture, model adapter API, tools, sandbox policy, and app-server
overview.
