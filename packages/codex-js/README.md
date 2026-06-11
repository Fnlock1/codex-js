# codex-js

`codex-js` is a standalone, pure ESM JavaScript terminal agent inspired by the
OpenAI Codex CLI runtime. It is designed as an independent CLI/runtime package:
it does not depend on the Qoder Open desktop editor, does not read `.env` files,
and does not lock you into a single model provider.

See [OPERATING_MODEL.md](./OPERATING_MODEL.md) for the package boundary,
default safety posture, and validation commands.

The project goal is practical: provide a terminal-first coding agent runtime
that can run with different model vendors, expose local tools through a guarded
tool loop, stream Codex-style events, and keep risky operations behind explicit
flags, approval, and sandbox checks.

> Status: experimental but usable. The package already includes CLI execution,
> pluggable model adapters, OpenAI-compatible/DeepSeek chat-completions support,
> tool routing, file tools, `apply_patch`, shell execution gates, approval,
> sandbox policy, MCP scaffolding, sub-agent records, sessions, and an app-server
> protocol surface. It is still not a full one-to-one replacement for upstream
> OpenAI Codex.

## Why This Exists

OpenAI Codex is primarily implemented in Rust. `codex-js` explores a JavaScript
translation of the non-model runtime ideas so the agent can be extended, debugged,
and embedded in JavaScript environments more easily.

This package is intentionally independent:

- no Electron/Vue/Monaco editor integration;
- no root workspace dependency requirement;
- no `.env` loading;
- no default model API calls;
- no default shell execution;
- no default file writes;
- no hidden API-key persistence.

You choose the model adapter, the working directory, and which tools are allowed.

## What It Can Do

- Run a terminal agent from `node ./bin/codex-js.js`.
- Stream human-readable output or JSONL thread events.
- Start and resume local thread sessions.
- Use mock, plugin, HTTP, DeepSeek, or OpenAI-compatible model adapters.
- Route model tool calls through a local `ToolRouter`.
- Feed tool results back into the model loop.
- Read, list, and search workspace files.
- Preview or apply `apply_patch` changes.
- Run shell commands only when explicitly enabled.
- Gate risky tools through approval and sandbox policy.
- Support MCP client/runtime scaffolding.
- Expose an app-server style JSONL transport for future UI or daemon use.
- Keep session history, response input items, and compact/rollback scaffolding.

## Requirements

- Node.js `>=22`
- npm for tests and package scripts

No npm dependencies are required by this package at the moment.

## Quick Start

From this package directory:

```bash
cd packages/codex-js
node ./bin/codex-js.js exec "hello"
node ./bin/codex-js.js exec "hello" --json-stream
```

Default mode uses the mock model client:

```text
codex-js mock response: hello
```

Run checks:

```bash
npm run check
npm test
```

## CLI Usage

```bash
node ./bin/codex-js.js --help
node ./bin/codex-js.js --version
node ./bin/codex-js.js exec "your task"
node ./bin/codex-js.js exec "your task" --json-stream
node ./bin/codex-js.js chat
node ./bin/codex-js.js tools list
node ./bin/codex-js.js tools inspect --json
node ./bin/codex-js.js tools doctor
node ./bin/codex-js.js thread list
node ./bin/codex-js.js app-server smoke "hello"
```

Useful flags:

```text
--cwd <path>                 Working directory for the turn.
--json / --json-stream       Emit JSONL events.
--session-store <path>       Custom local session directory.
--resume <thread-id>         Resume an existing thread.
--model-adapter <file>       Load a local ESM model adapter.
--model-url <url>            Use an HTTP model adapter.
--model-provider <name>      Built-in provider: deepseek, openai-compatible.
--model <name>               Model name for the provider.
--model-base-url <url>       Base URL for OpenAI-compatible providers.
--model-api-key <key>        Runtime API key. Not persisted by codex-js.
--model-timeout <ms>         HTTP model timeout.
--max-tool-iterations <n>    Limit model/tool loop iterations.
--allow-shell                Allow model-requested shell commands.
--allow-apply-patch          Allow model-requested patch writes.
--allow-network              Allow network-risk tools/commands by sandbox policy.
--allow-mcp                  Allow configured MCP stdio servers.
--yes                        Auto-approve CLI prompts for this run.
--sandbox <mode>             read-only, workspace-write, danger-full-access.
```

On Windows, use UTF-8 terminal encoding when your prompt or paths contain
Chinese text:

```powershell
chcp 65001
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

## Using DeepSeek

`codex-js` includes a DeepSeek helper built on the OpenAI-compatible Chat
Completions shape.

```powershell
node .\bin\codex-js.js exec "帮我查看当前目录结构" `
  --model-provider deepseek `
  --model v4-pro `
  --model-api-key "<runtime key>" `
  --cwd "F:\your\workspace" `
  --json-stream
```

Short model aliases:

```text
v4-pro    -> deepseek-v4-pro
v4-flash  -> deepseek-v4-flash
```

Do not commit or paste real API keys into public issues, logs, or README files.
`codex-js` does not read `.env` and does not persist CLI keys.

## OpenAI-Compatible Providers

Any provider that supports the Chat Completions request/response shape can be
used through `openai-compatible`:

```bash
node ./bin/codex-js.js exec "hello" \
  --model-provider openai-compatible \
  --model "provider-model-name" \
  --model-base-url "https://provider.example/v1" \
  --model-api-key "<runtime key>"
```

The adapter:

- sends `messages` to `/chat/completions`;
- sends model-visible function tools through the `tools` field;
- parses `reasoning_content`, `tool_calls`, and assistant `content`;
- converts tool outputs into `role: "tool"` follow-up messages;
- includes a default terminal-agent system prompt;
- redacts provider error bodies before displaying them.

## Local Plugin Model Adapter

You can provide your own ESM module:

```bash
node ./bin/codex-js.js exec "hello" --model-adapter ./my-model-adapter.mjs
```

Minimal adapter:

```js
export function generate(prompt) {
  return `answer: ${prompt.inputText}`;
}
```

Tool-call adapter:

```js
let turn = 0;

export function generate(prompt) {
  turn += 1;

  if (turn === 1) {
    return {
      type: "function_call",
      callId: "call-1",
      name: "read_file",
      arguments: {
        path: "README.md"
      }
    };
  }

  return `file text:\n${prompt.responseInputItems[0].output.body}`;
}
```

Adapters may export:

```text
default
generate()
generateResponse()
streamResponse()
```

They can return:

- a string;
- one response item;
- an array of response items;
- an async iterable of response items.

The adapter receives `(prompt, context)`:

```js
export function generate(prompt, context) {
  const prefix = context.adapterOptions.prefix ?? "answer:";
  return `${prefix} ${prompt.inputText}`;
}
```

Pass adapter options:

```bash
node ./bin/codex-js.js exec "hello" \
  --model-adapter ./my-model-adapter.mjs \
  --model-option prefix=local \
  --model-options-json "{\"temperature\":0.2}"
```

## HTTP Model Adapter

Use an HTTP endpoint instead of a local module:

```bash
node ./bin/codex-js.js exec "hello" \
  --model-url http://127.0.0.1:8787/model \
  --model-header Authorization=Bearer-local-token
```

The endpoint receives:

```json
{
  "prompt": {
    "inputText": "hello",
    "threadId": "...",
    "workingDirectory": "...",
    "tools": [],
    "responseInputItems": []
  },
  "session": {}
}
```

It may return plain text, JSON, or JSONL. JSON can be:

```json
"plain answer"
```

```json
{ "text": "plain answer" }
```

```json
{
  "items": [
    {
      "type": "function_call",
      "callId": "call-1",
      "name": "list_files",
      "arguments": {
        "path": "."
      }
    }
  ]
}
```

## How The Agent Works

The runtime follows a simple model/tool loop.

```text
User prompt
  |
  v
Thread + TurnContext
  |
  v
ModelClientSession.streamResponse()
  |
  +-- assistant message/reasoning -> stream item events
  |
  +-- function_call/tool_call ----> ToolRouter
                                      |
                                      v
                                  Tool handler
                                      |
                                      v
                              tool_result event
                                      |
                                      v
                       responseInputItems for next model call
  |
  v
No more tool calls -> assistant final message -> turn.completed
```

Important pieces:

- `Codex` creates or resumes threads.
- `Thread` owns the working directory, session store, runtime, and tool registry.
- `TurnContext` carries input text, cwd, thread id, tool specs, and prior response items.
- `ModelClient` abstracts the model provider.
- `LoopingTurnRuntime` drives model turns and tool loops.
- `ToolRegistry` stores model-visible, deferred, and hidden tool specs.
- `ToolRouter` runs tool handlers and applies approval/sandbox gates.
- `SessionStore` persists local thread records.

When a model returns a tool call, `LoopingTurnRuntime` emits:

```text
item.started       tool_call
item.completed     tool_call
item.completed     tool_result
```

The `tool_result` is converted into a Responses-style input item such as
`function_call_output` and sent back to the next model call.

## Event Stream

JSONL mode emits Codex-style thread events:

```text
thread.started
turn.started
item.started
item.updated
item.completed
turn.completed
turn.failed
error
```

Example:

```bash
node ./bin/codex-js.js exec "hello" --json-stream
```

Each line is a JSON object. This makes the CLI easy to consume from scripts,
tests, app-server transports, or future UI clients.

## Tools

Core model-visible tools include:

```text
shell_command      Run a shell command when shell execution is enabled.
exec               Alias for non-interactive shell execution.
exec_command       Start a command session scaffold.
write_stdin        Write to an existing command session.
apply_patch        Parse, preview, or apply canonical patch text.
read_file          Read a UTF-8 file.
list_files         List files and directories.
search_files       Search files for literal text.
git_status         Show git status through the exec runtime.
git_diff           Show git diff through the exec runtime.
request_permissions Request extra filesystem/network permission.
view_image         Read a local image and return a data URL.
web_search         Hosted provider tool when enabled.
image_generation   Hosted provider tool when enabled.
spawn_agent        Start a local child-agent task.
wait_agent         Wait for a child-agent result.
```

Deferred or internal tools include MCP resource tools, `tool_search`, and goal
helpers.

Inspect tools:

```bash
node ./bin/codex-js.js tools list
node ./bin/codex-js.js tools inspect --json
node ./bin/codex-js.js tools doctor
```

## File Editing With apply_patch

`apply_patch` expects canonical patch text:

```text
*** Begin Patch
*** Add File: index.html
+<!DOCTYPE html>
+<html>
+<body>Hello</body>
+</html>
*** End Patch
```

By default, patch text can be parsed and previewed. Real writes require:

```bash
--allow-apply-patch
```

Example:

```bash
node ./bin/codex-js.js exec "create index.html" \
  --model-adapter ./my-model-adapter.mjs \
  --allow-apply-patch \
  --yes
```

The parser supports add, delete, update, move, EOF markers, and heredoc wrappers.
It blocks absolute paths and path escapes by default.

## Shell Execution

Real shell execution is disabled unless you pass:

```bash
--allow-shell
```

Example:

```bash
node ./bin/codex-js.js exec "run tests" \
  --model-adapter ./my-model-adapter.mjs \
  --allow-shell
```

Without `--yes`, the CLI prompts before approved tool runs. With `--yes`, prompts
are auto-approved for that one CLI run.

Shell command results include stdout, stderr, exit code, timeout status, and
aggregated output. Non-zero exit codes are treated as failed tool results.

## Sandbox And Approval

The default sandbox mode is `workspace-write`.

Modes:

```text
read-only           No writes and no shell execution.
workspace-write     Reads/writes stay inside the working directory roots.
danger-full-access  Allows access outside the workspace.
```

Configure sandbox:

```bash
node ./bin/codex-js.js exec "task" \
  --model-adapter ./my-model-adapter.mjs \
  --sandbox workspace-write \
  --sandbox-read-root ./docs \
  --sandbox-write-root ./generated
```

Network-risk commands such as package installation or `curl` are blocked unless
network access is enabled:

```bash
--allow-network
```

Sensitive environment keys such as API keys and tokens are filtered from
model-requested shell environments.

## Hosted Tools

`web_search` and `image_generation` are exposed only when hosted tools are
enabled and provider URLs are supplied.

```bash
node ./bin/codex-js.js exec "search the web" \
  --model-adapter ./my-model-adapter.mjs \
  --enable-hosted-tools \
  --web-search-url http://127.0.0.1:8787/search \
  --hosted-tool-header Authorization=Bearer-local-token \
  --allow-network
```

```bash
node ./bin/codex-js.js exec "generate an image" \
  --model-adapter ./my-model-adapter.mjs \
  --enable-hosted-tools \
  --image-generation-url http://127.0.0.1:8787/image \
  --allow-network
```

The provider receives JSON:

```json
{
  "kind": "web_search",
  "arguments": {},
  "tool": {
    "name": "web_search"
  }
}
```

## MCP

MCP support is present as a guarded runtime surface. Stdio MCP servers are not
spawned unless `--allow-mcp` is used.

```bash
node ./bin/codex-js.js exec "use mcp" \
  --model-adapter ./my-model-adapter.mjs \
  --allow-mcp \
  --mcp-server fs="node ./mcp-server.mjs"
```

When no MCP server is connected, MCP tools return safe `mcp_not_connected`
results.

## App Server

`codex-js` includes a local app-server protocol and transports for future UI or
daemon usage.

Smoke test:

```bash
node ./bin/codex-js.js app-server smoke "hello"
```

Stdio JSONL transport:

```bash
node ./bin/codex-js.js app-server stdio
```

Supported surfaces include thread start/read/list, turn start/steer/interrupt,
filesystem operations, process APIs, command APIs, server requests, permission
profiles, config reads/writes, MCP status/resource/tool calls, and experimental
feature controls.

## Public JavaScript API

```js
import { Codex, LoopingTurnRuntime, createDeepSeekModelClient } from "codex-js";

const modelClient = createDeepSeekModelClient({
  apiKey: process.env.DEEPSEEK_API_KEY,
  model: "deepseek-v4-pro"
});

const codex = new Codex({
  workingDirectory: process.cwd(),
  runtime: new LoopingTurnRuntime({
    modelClient
  })
});

const thread = codex.startThread();
const result = await thread.run("hello");

console.log(result.finalResponse);
```

Core exports include:

- `Codex`
- `Thread`
- `LoopingTurnRuntime`
- `MockTurnRuntime`
- `ModelClient`
- `ToolRegistry`
- `ToolRouter`
- `SafeToolCallRuntime`
- `SandboxPolicy`
- `ApprovalPolicy`
- `createDeepSeekModelClient`
- `createOpenAICompatibleModelClient`
- protocol/event/item helpers

## Configuration

Use a JSON config file to avoid long CLI commands.

```json
{
  "workingDirectory": "./",
  "model": {
    "provider": "plugin",
    "adapterPath": "./my-model-adapter.mjs",
    "options": {
      "prefix": "local"
    }
  },
  "sandbox": {
    "mode": "workspace-write",
    "networkAllowed": false
  }
}
```

Run:

```bash
node ./bin/codex-js.js exec "hello" --config ./codex-js.json
```

Inspect config safely:

```bash
node ./bin/codex-js.js config inspect --config ./codex-js.json
```

Secrets are redacted in printed config.

## What Is Not Finished Yet

Known gaps compared with upstream Codex:

- no full interactive TUI;
- no built-in OpenAI auth/account flow;
- no complete upstream TOML config layer stack;
- no full task-level verification stage yet;
- no full skills/hooks/plugin marketplace implementation;
- no complete realtime/audio support;
- no full Windows sandbox setup workflow;
- MCP is available but still intentionally guarded and not auto-started;
- sub-agents are local child turns, not a full distributed worker system.

The current priority is terminal stability: model adapter quality, tool-call
correctness, file-write reliability, sandbox behavior, and verification.

## Safety Model

The default posture is conservative:

- no `.env` loading;
- no stored API keys;
- no real shell unless `--allow-shell`;
- no real patch writes unless `--allow-apply-patch`;
- no network-risk commands unless network is allowed;
- no MCP stdio spawn unless `--allow-mcp`;
- approval prompts unless auto-approved for the current run;
- sandbox path checks for file and command tools.

This does not make the agent risk-free. If you pass `--yes`,
`--allow-shell`, `--allow-apply-patch`, or `danger-full-access`, you are giving
the model more power over the local machine. Use those flags only in directories
you trust.

## Development

Run syntax checks:

```bash
npm run check
```

Run tests:

```bash
npm test
```

CLI smoke:

```bash
node ./bin/codex-js.js exec "hello"
node ./bin/codex-js.js exec "hello" --json-stream
node ./bin/codex-js.js tools doctor
```

## Project Layout

```text
bin/
  codex-js.js                  CLI entry
src/
  cli.js                       command parsing and CLI orchestration
  codex.js                     public Codex facade
  thread.js                    thread/session execution API
  core/                        model loop, turn runtime, ReAct trace
  protocol/                    event/item/model/input helpers
  model-adapters/              plugin/http/openai-compatible adapters
  tools/                       tool specs, router, handlers, runtime
  apply-patch/                 parser, plan, filesystem runtime
  exec/                        runner, runtime, permission policy, sessions
  sandbox/                     sandbox policy and path checks
  approval/                    approval policy and gate
  mcp/                         MCP client/runtime/protocol
  app-server/                  JSONL app-server protocol and transports
  session/                     history, rollout, compaction scaffolding
test/                          Node built-in test suite
```

## Relationship To Qoder Open

`codex-js` lives under the same repository, but it is not wired into the Qoder
Open Electron/Vue/Monaco editor. The desktop editor remains a normal code editor.
This package is a standalone terminal-agent runtime.

## License

Apache-2.0, as declared in `package.json`.
