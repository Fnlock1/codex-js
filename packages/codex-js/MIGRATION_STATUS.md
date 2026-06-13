# Codex JS Migration Status

## Update 2026-06-06

Current terminal-first status:

- Added built-in OpenAI-compatible chat-completions model adapter.
- Added DeepSeek provider helper with default model `deepseek-v4-pro`.
- Added DeepSeek short aliases: `v4-pro` -> `deepseek-v4-pro`, `v4-flash` -> `deepseek-v4-flash`.
- The adapter sends model-visible function tools through the Chat Completions `tools` field.
- The adapter parses `reasoning_content`, `tool_calls`, and assistant `content`.
- Tool output is fed back as Chat Completions `role: "tool"` messages.
- CLI supports `--model-provider deepseek`, `--model`, `--model-base-url`, and `--model-api-key`.
- `config inspect` redacts API keys, Authorization headers, tokens, secrets, and passwords.
- The user-provided real DeepSeek key was not written to repository files.

Validation note:

- System `node` and `npm` are not available in the current shell PATH, so full `npm run check` / `npm test` could not be executed here.
- Module-level validation was performed with the available Node REPL MCP for the OpenAI-compatible adapter and config redaction.

更新时间：2026-06-05

## 总目标

把 OpenAI Codex 的非模型能力迁移成一个独立的纯 ESM JavaScript 包：

```text
packages/codex-js
```

目标是让 `codex-js` 作为一个独立 Codex runtime / CLI / app-server 个体存在，后续可以继续对齐上游 OpenAI Codex。

上游参考仓库：

```text
F:\接单\qoder开源版本\codex-main\codex-main
```

主要参考目录：

```text
codex-rs\protocol
codex-rs\core
codex-rs\exec
codex-rs\app-server
codex-rs\app-server-protocol
codex-rs\config
codex-rs\features
codex-rs\mcp-server
codex-rs\tui
sdk
docs
```

## 固定边界

这些边界目前保持不变：

- 不接入现有 Electron / Vue / Monaco 编辑器。
- 不修改根 `package.json`。
- 不修改根 `pnpm-workspace.yaml`。
- 不修改根 lockfile。
- 不读取或修改 `.env`。
- 不实现真实 OpenAI model provider。
- 不默认调用真实模型。
- 不默认执行真实 shell。
- 不默认启动 MCP server。
- 不默认写真实 workspace 文件。
- 真实危险能力必须显式开关或通过 approval / sandbox 后再启用。

Qoder Open 当前仍然是桌面代码编辑器。`packages/codex-js` 是单独迁移出来的 Codex JS 包，不和编辑器混在一起。

## 当前包形态

当前包是纯 JavaScript ESM：

```text
packages/codex-js/package.json
packages/codex-js/bin/codex-js.js
packages/codex-js/src
packages/codex-js/test
```

CLI 命令名：

```text
codex-js
```

可直接在包目录运行：

```powershell
cd F:\接单\qoder开源版本\packages\codex-js
node .\bin\codex-js.js exec "hello"
node .\bin\codex-js.js exec "hello" --json
```

## 已完成能力

### 1. 独立 CLI / Runtime 骨架

已完成：

- `codex-js --help`
- `codex-js --version`
- `codex-js exec <prompt>`
- `codex-js exec <prompt> --json`
- `codex-js config default`
- `codex-js config inspect`
- `codex-js app-server smoke`
- `codex-js app-server stdio`
- thread CLI 的 start / list / update / fork / archive / unarchive 等基础命令

特点：

- 不读取 `.env`。
- 默认不调用真实模型。
- 默认不执行真实 shell。
- JSONL 输出已能发出 Codex 风格事件。

### 2. Thread / Session / History

已完成：

- `Codex` 类。
- `Thread` 类。
- `startThread()`。
- `resumeThread()`。
- `thread.run()`。
- `thread.runStreamed()`。
- session store。
- thread list / resume / archive / unarchive / fork / rollback。
- thread metadata update。
- thread name set。
- thread goal set / get / clear。
- thread unsubscribe。
- thread inject_items。
- raw Responses item 注入到后续 turn input。
- history / rollout / compact scaffold。

还不是完整上游等价，但已经有稳定的 JS API 和测试。

### 3. Protocol / Items / Events

已完成：

- thread event helper。
- item helper。
- Responses 风格 model item helper。
- `message`。
- `reasoning`。
- `function_call`。
- `custom_tool_call`。
- `function_call_output`。
- `custom_tool_call_output`。
- `normalizeResponseItems()`。
- `createResponseInputMessageItem()`。
- `createResponseToolCallOutputItem()`。
- `responseItemToText()`。
- command execution item。
- tool call item。
- tool result item。
- permission constants scaffold。

事件目前包含：

- `thread.started`
- `turn.started`
- `item.started`
- `item.updated`
- `item.completed`
- `turn.completed`
- `turn.failed`
- `error`

### 4. Mock / Scripted Model Adapter

已完成：

- `ModelClient` 接口。
- `ModelClientSession` 接口。
- `MockModelClient`。
- `MockModelClientSession`。
- scripted model responses。
- model prompt 组装。
- tool output 回灌给下一轮 model input。

注意：

- 真实模型 provider 暂时不接。
- 后续可以接自定义模型。
- runtime 不依赖 OpenAI client。

### 5. Turn Loop

已完成：

- `MockTurnRuntime`。
- `LoopingTurnRuntime`。
- 多轮 tool loop 骨架。
- `maxToolIterations` 保护。
- function call tool output 回灌。
- custom tool call output 回灌。
- tool runtime 抛错时能产生 `turn.failed` / `error` 闭环。

### 6. Tool Runtime / Registry / Router

已完成：

- `ToolRegistry`。
- `ToolRouter`。
- `ToolCallRuntime`。
- `NoopToolCallRuntime`。
- `SafeToolCallRuntime`。
- built-in tool specs。
- model-visible / deferred / hidden tool spec 区分。
- placeholder tools。
- approval gate metadata 映射。

已覆盖的工具形态：

- shell command dry-run。
- exec command scaffold。
- write stdin placeholder。
- apply_patch。
- request_permissions。
- MCP resource read。
- MCP tool call。
- web search placeholder。
- image / view image placeholder。
- sub-agent placeholder。

### 7. Apply Patch

已完成：

- apply patch parser。
- heredoc wrapper 解析。
- add / delete / update / move hunk 解析。
- EOF 处理。
- dry-run summary。
- patch plan 计算。
- workspace path 解析。
- absolute path / path escape 阻止。
- sandbox write policy 检查。
- blocked FS runtime。
- real FS runtime behind explicit allow flag。
- `SafeToolCallRuntime.apply_patch` 可 dry-run。
- 显式允许后可以真实应用 patch。

安全默认：

- 默认不写文件。
- 真实 apply patch 需要显式 `allowApplyPatch` 或相应 gate。

### 8. Exec Runner / Command Sessions

已完成：

- `ExecRunner`。
- `DryRunExecRuntime`。
- `BlockedExecRuntime`。
- `RealExecRuntime`。
- stdout / stderr 聚合。
- exit code。
- timeout。
- env override。
- direct argv。
- platform shell command helper。
- exec approval policy。
- command session manager。
- real command session manager behind explicit injection。
- app-server command exec / write / terminate / resize。
- command output delta notification。

安全默认：

- CLI 默认仍是 dry-run。
- app-server 默认不开放真实 session manager。
- 真实执行能力只在测试或显式注入 runtime 时可用。

### 9. Approval / Sandbox / Permissions

已完成：

- approval policy。
- approval gate。
- approve for session。
- forbidden / prompt / allow 决策。
- exec approval request。
- file change approval request。
- permissions approval request。
- `request_permissions` tool handler。
- permission grant store。
- permission profile list。
- builtin permission profile summaries。
- read-only / workspace-write / danger-full-access sandbox policy。
- path boundary check。
- exec sandbox check。

注意：

- request_permissions 当前只是记录 grant。
- grant 还没有真正自动放开 shell / MCP / FS 权限。

### 10. MCP

已完成：

- MCP protocol helpers。
- static MCP client。
- managed MCP client。
- stdio MCP client。
- MCP server registry。
- MCP runtime。
- dynamic MCP tool definitions。
- MCP resource read。
- MCP tool call。
- server status list。
- approval gate 支持。
- 默认不连接时返回安全失败。
- stdio spawn 默认 blocked。
- 显式 `allowStdioSpawn: true` 才能启动 stdio MCP server。

### 11. App Server

已完成较多上游 app-server v2 风格接口：

- `initialize`
- `initialized`
- `thread/start`
- `thread/resume`
- `thread/fork`
- `thread/read`
- `thread/list`
- `thread/loaded/list`
- `thread/turns/list`
- `thread/archive`
- `thread/unarchive`
- `thread/unsubscribe`
- `thread/inject_items`
- `thread/name/set`
- `thread/goal/set`
- `thread/goal/get`
- `thread/goal/clear`
- `thread/rollback`
- `thread/metadata/update`
- `thread/settings/update`
- `thread/compact/start`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `command/exec`
- `command/exec/write`
- `command/exec/terminate`
- `command/exec/resize`
- `fs/readFile`
- `fs/writeFile`
- `fs/createDirectory`
- `fs/getMetadata`
- `fs/readDirectory`
- `fs/remove`
- `fs/copy`
- `fs/watch`
- `fs/unwatch`
- `process/spawn`
- `process/writeStdin`
- `process/resizePty`
- `process/kill`
- `serverRequest/list`
- `serverRequest/resolve`
- `permissionProfile/list`
- `config/read`
- `config/value/write`
- `config/batchWrite`
- `configRequirements/read`
- `mcpServerStatus/list`
- `mcpServer/resource/read`
- `mcpServer/tool/call`

Transport：

- in-process transport。
- stdio JSONL transport。
- JSONL wire 不输出 `jsonrpc` 字段，靠近上游文档。

### 12. Config Read / Write

已完成：

- JSON config schema。
- default config。
- config inspect。
- app-server `config/read`。
- app-server `configRequirements/read`。
- app-server `config/value/write`。
- app-server `config/batchWrite`。
- `keyPath`。
- `mergeStrategy: replace | upsert`。
- `value: null` 清路径。
- quoted keyPath，例如 `desktop."selected-avatar-id"`。
- `expectedVersion` 冲突检测。
- 上游风格响应：
  - `status`
  - `version`
  - `filePath`
  - `overriddenMetadata`
- 上游风格错误码：
  - `configLayerReadonly`
  - `configValidationError`
  - `configVersionConflict`
  - `userLayerNotFound`

安全默认：

- 默认禁止 config write。
- 必须显式 `allowConfigWrites: true`。
- 只写指定的 codex-js JSON config。
- 还没有写上游 `config.toml`。

## 当前未完成 / 正在进行

### Experimental Feature 协议

上游有：

- `experimentalFeature/list`
- `experimentalFeature/enablement/set`

目前本地 JS 包已经开始写这一块，但还没有完成接线和测试。

已经新增或开始改动：

```text
src/app-server/experimental-features.js
src/app-server/protocol.js
```

当前状态：

- feature catalog 文件已创建。
- `APP_SERVER_METHODS` 已加入：
  - `EXPERIMENTAL_FEATURE_LIST`
  - `EXPERIMENTAL_FEATURE_ENABLEMENT_SET`
- 还没接入 `CodexAppServer.dispatch()`。
- 还没把 runtime enablement 投影进 `config/read`。
- 还没导出到 `src/index.js`。
- 还没把新文件加入 `package.json` 的 `npm run check`。
- 还没补测试。
- 因此这一块属于“开始写了，但未完成、未验证”。

建议下一步优先把这块补完，避免半接线状态停太久。

## 最近一次可靠验证状态

在开始 experimental feature 之前，以下命令通过：

```powershell
cd F:\接单\qoder开源版本\packages\codex-js
npm run check
```

通过。

```powershell
$env:TMP='F:\接单\qoder开源版本\packages\codex-js\.tmp-tests'
$env:TEMP=$env:TMP
New-Item -ItemType Directory -Force -Path $env:TMP | Out-Null
node --test test\app-server.test.js
```

通过，app-server 测试 37 个。

```powershell
$env:TMP='F:\接单\qoder开源版本\packages\codex-js\.tmp-tests'
$env:TEMP=$env:TMP
New-Item -ItemType Directory -Force -Path $env:TMP | Out-Null
npm test
```

通过，220 个测试。

注意：

- 这些是 experimental feature 半成品改动之前的可靠绿灯。
- 当前已有未完成的 experimental feature 代码，所以继续开发前应该先补完并重新跑验证。
- Windows 当前 C 盘可能空间不足，跑全量测试时建议继续把 `TMP` / `TEMP` 指到 F 盘。

## 后续迁移顺序

建议继续按这个顺序做，不再每个模块反复询问：

1. 补完 `experimentalFeature/list` 和 `experimentalFeature/enablement/set`。
2. 补 `externalAgentConfig/detect` / `externalAgentConfig/import` 的安全协议壳。
3. 补 `skills/list`、`skills/extraRoots/set`、`skills/config/write`。
4. 补 `hooks/list` 和 hook 配置读取。
5. 补 plugin / marketplace 协议壳。
6. 补 `review/start`。
7. 补 model list / model provider capabilities 的非真实模型版本。
8. 补 account / auth / rate limit 的安全 placeholder。
9. 补 windows sandbox setup / readiness。
10. 补 app list / feedback / fuzzy file search / git diff / conversation summary。
11. 深化 session history / compact / truncation / rollout trace。
12. 深化 TOML config layer stack：
    - user config
    - project `.codex/config.toml`
    - managed config
    - requirements
    - origin/layer metadata
13. 深化 approval grant 对真实工具权限的实际影响。
14. 深化 MCP client/server 与 deferred tool discovery。
15. 以后再接用户自己的模型 provider，或 OpenAI-compatible provider。

## 仍未迁完的大块

### 配置系统

还缺：

- 上游 `config.toml` 完整 parser / writer。
- config layer stack。
- project `.codex/config.toml`。
- managed config。
- cloud / MDM requirements。
- strict config。
- requirements enforcement。
- config hot reload into loaded threads。

### Skills

还缺：

- skills discovery。
- extra roots。
- skill config write。
- skill MCP dependency detection。
- skill env/config requirements。

### Hooks

还缺：

- hook list。
- managed hooks。
- hook matcher groups。
- hook execution lifecycle。
- pre/post tool use hooks。
- session start / stop hooks。

### Plugin / Marketplace

还缺：

- plugin list/read/install/uninstall。
- plugin skill read。
- plugin share save/list/checkout/delete。
- marketplace add/remove/upgrade。
- plugin cache invalidation。

### Review

还缺：

- `review/start`。
- diff review mapping。
- guardian denied action flow 的完整实现。

### Account / Auth

还缺：

- account read。
- login start/cancel。
- logout。
- rate limits read。
- add credits nudge。
- auth status。

注意：

- 因为真实模型 provider 暂停，这一块可以先做安全 placeholder，不接 OpenAI auth。

### Realtime

还缺：

- realtime conversation。
- SDP。
- transcript delta/done。
- output audio delta。

### Windows Sandbox

还缺：

- windowsSandbox/setupStart。
- windowsSandbox/readiness。
- elevated / unelevated mode。
- setup completed notification。
- world-writable warning。

### App Server 杂项

还缺：

- app/list。
- feedback/upload。
- getConversationSummary。
- gitDiffToRemote。
- fuzzyFileSearch。
- model/list。
- modelProvider/capabilities/read。
- config/mcpServer/reload。
- mcp oauth login。

### TUI

还缺：

- 交互 TUI。
- approval prompt UI。
- config UI。
- status line。
- bottom pane。
- session picker。

当前优先级仍然是非交互 CLI / runtime / app-server，不急着做 TUI。

## 验证命令

推荐每轮至少跑：

```powershell
cd F:\接单\qoder开源版本\packages\codex-js
npm run check
```

跑全量测试时用 F 盘临时目录：

```powershell
cd F:\接单\qoder开源版本\packages\codex-js
$env:TMP='F:\接单\qoder开源版本\packages\codex-js\.tmp-tests'
$env:TEMP=$env:TMP
New-Item -ItemType Directory -Force -Path $env:TMP | Out-Null
npm test
```

跑完可清理：

```powershell
Remove-Item -LiteralPath 'F:\接单\qoder开源版本\packages\codex-js\.tmp-tests' -Recurse -Force -ErrorAction SilentlyContinue
```

CLI smoke：

```powershell
node .\bin\codex-js.js exec "hello"
node .\bin\codex-js.js exec "hello" --json
node .\bin\codex-js.js exec "ignored" --json --dry-run-command "npm test"
```

App-server stdio smoke：

```powershell
@'
{"method":"initialize","id":1,"params":{}}
{"method":"thread/start","id":2,"params":{}}
'@ | node .\bin\codex-js.js app-server stdio
```

## 当前风险点

1. `src/app-server/experimental-features.js` 是新加但未完全接线的半成品。
2. `package.json` 的 `npm run check` 还没有包含这个新文件。
3. `src/app-server/protocol.js` 已经加入 experimental feature 方法常量，但 server dispatch 还没处理。
4. 测试临时目录 `.tmp-tests` 可能存在，属于测试生成目录。
5. 有一个疑似历史误生成的 0 字节文件：

```text
packages/codex-js/process.stdout.write('done'))
```

之前没有删除它，因为它和迁移逻辑无关。

## 一句话总结

`packages/codex-js` 已经从最初 mock CLI 骨架推进到一个具备 protocol、thread/session、tool loop、apply_patch、exec、approval、sandbox、MCP scaffold、app-server 大量接口、config read/write 的独立 Codex JS runtime。真实模型层仍按用户要求暂停。下一步应该优先完成已经开始的 experimental feature app-server 协议，然后继续迁 skills / hooks / plugin / marketplace 等非模型能力。
