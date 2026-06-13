# @qoder-open/shared

Shared serializable editor protocol types for Qoder Open.

This package is used by:

- Electron main IPC handlers.
- Electron preload APIs exposed through `window.qoder`.
- Vue renderer state and UI code.

## Contents

- `src/index.ts`: Workspace, file tree, Git, terminal, language-service, diagnostics, and project-index DTOs.
- `dist`: Generated JavaScript and declaration output. Do not edit manually.
- `tsconfig.json`: TypeScript build configuration.

## Boundaries

This package should contain data shapes and lightweight platform-independent types only.

Allowed:

- Serializable DTOs.
- String/number/boolean/null/array/object based protocol types.
- Editor-facing workspace, Git, terminal, language-service, diagnostics, and project-index types.

Not allowed:

- Electron, Vue, Monaco, or Node runtime objects.
- Filesystem, process, LSP, or IPC implementation logic.
- AI, agent, model-provider, MCP, approval, or tool-call runtime types.
- Imports from `packages/codex-js`.

## Validation

```bash
pnpm --filter @qoder-open/shared check
pnpm --filter @qoder-open/shared build
```
