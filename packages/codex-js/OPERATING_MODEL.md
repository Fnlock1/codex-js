# codex-js Operating Model

`packages/codex-js` is treated as a standalone experimental agent runtime. It is
not part of the Qoder Open desktop workspace unless the product direction
explicitly changes.

## Current Boundary

- Keep it independent from `apps/desktop`.
- Do not add it to `pnpm-workspace.yaml` as a side effect of runtime work.
- Do not load `.env` files.
- Do not make real model calls by default.
- Do not execute shell commands by default.
- Do not write files by default.
- Do not start MCP stdio servers by default.

## Default Safety Posture

The default runtime should be useful for inspection and planning while staying
dry-run first:

- file read/list/search can run inside the configured workspace;
- `apply_patch` previews changes unless writes are explicitly enabled;
- shell tools return dry-run output unless shell execution is explicitly enabled;
- risky tools should pass through approval and sandbox checks before running;
- hosted tools, network access, and MCP stdio servers are opt-in.

## Validation

Run validation from the package directory:

```bash
npm run check
npm test
```

From the repository root, use:

```bash
npm --prefix packages/codex-js run check
npm --prefix packages/codex-js test
```

The focused end-to-end guardrail is:

```bash
node --test test/e2e-agent-turn.test.js
```

## Optimization Priorities

1. Preserve a real model/tool loop with regression tests for search, read,
   patch preview, approval-blocked writes, and explicitly approved writes.
2. Unify approval, sandbox, and permission checks around a single capability
   policy model.
3. Add structured tracing and replay data for each turn.
4. Add strict tool argument validation before handlers run.
5. Improve context assembly before expanding the tool surface.
