# Qoder Open Packages

This directory contains workspace packages used by Qoder Open.

## Packages

| Package | Purpose |
| --- | --- |
| `shared` | Serializable editor protocol types shared by Electron main, preload, and the Vue renderer. |
| `codex-js` | Standalone experimental JavaScript runtime for Codex-style agent research and migration work. |

## Boundaries

- `shared` is part of the Qoder Open desktop editor surface. Keep it lightweight, serializable, and editor-focused.
- `codex-js` is not part of the desktop editor runtime. It must stay standalone unless the product direction is explicitly changed.
- Do not import `codex-js` from `apps/desktop` or `packages/shared`.
- Do not add model providers, MCP, agent loops, or approval runtimes to `shared`.

## Generated Files

Do not manually edit generated outputs such as:

- `dist`
- `out`
- `node_modules`
- `*.tsbuildinfo`
