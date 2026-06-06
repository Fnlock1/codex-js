# Qoder Open Handoff

更新时间：2026-06-04

## 当前项目定位

Qoder Open 当前是一个 Electron + Vue + Monaco 的桌面代码编辑器。

之前的 AI / agent / Quest / Experts / model provider / MCP / CLI agent 方向已经被移除。后续接手时不要再按照旧的 agentic coding assistant 目标继续堆功能。

## 保留能力

- Electron 桌面应用。
- Vue renderer。
- Monaco 编辑器。
- 工作区文件树。
- 文件打开、编辑、保存、另存为。
- 工作区搜索。
- Git 状态、diff、stage、unstage、discard、commit、branches。
- `node-pty` 集成终端。
- 语言服务桥接：completion、hover、definition、references、diagnostics、code actions、rename、format、semantic tokens。
- Project Index：索引摘要和符号搜索。

## 已移除能力

- Agent runtime。
- Quest / Assistant UI。
- Experts mode。
- Model providers。
- Tool-call loop。
- Approval runtime。
- MCP adapter。
- CLI agent runner。
- `packages/agent-core`、`packages/model-providers`、`packages/tools`、`cli`。

## 当前模块

| 模块 | 路径 | 说明 |
| --- | --- | --- |
| Desktop main | `apps/desktop/src/main/index.ts` | Electron IPC、窗口、workspace、terminal、language service、project index |
| Preload API | `apps/desktop/src/preload/index.ts` | 暴露 `window.qoder` 编辑器 API |
| Renderer app | `apps/desktop/src/renderer/src/App.vue` | Workbench 布局 |
| Workspace state | `apps/desktop/src/renderer/src/composables/useWorkspace.ts` | 文件、搜索、Git、编辑状态 |
| Terminal state | `apps/desktop/src/renderer/src/composables/useTerminal.ts` | 底部终端状态 |
| Monaco editor | `apps/desktop/src/renderer/src/components/MonacoEditor.vue` | Monaco 实例和模型同步 |
| Language bridge | `apps/desktop/src/main/language-service.ts` | LSP 进程和协议桥接 |
| Project index | `apps/desktop/src/main/project-index-service.ts` | 轻量符号索引 |
| Shared types | `packages/shared/src/index.ts` | 编辑器相关共享类型 |

## 开发规则

- 不要重新引入 AI / agent / model provider / MCP / Quest UI，除非用户明确改变产品方向。
- 不要编辑 `dist`、`out`、`node_modules`、`*.tsbuildinfo` 这类生成文件。
- 不要读取或修改 `.env`。
- Desktop main 负责本地能力和 IPC；renderer 负责 UI；shared 只放可序列化类型。
- 文件修改后要保持语言服务和项目索引刷新。
- Windows 路径兼容要优先考虑。
- Vue 语言能力继续通过官方 `@vue/language-server` 和 `@vue/typescript-plugin`，不要手写静态补全冒充 LSP。

## 验证命令

```bash
pnpm --filter @qoder-open/shared check
pnpm --filter @qoder-open/desktop check
pnpm --filter @qoder-open/desktop build
```

影响桌面 UI 时，至少确认：

- 应用能启动。
- 文件树能加载。
- 文件能打开、编辑、保存。
- 终端能创建并显示输出。
- Problems / language services 不因改动报错。
