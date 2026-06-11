# @qoder-open/shared

这个包定义桌面编辑器共用的、可序列化的 TypeScript 类型。

它主要被这些模块引用：

- Electron main 进程 IPC 处理逻辑。
- Electron preload 暴露的 `window.qoder` API。
- Vue renderer 的状态管理和 UI。

## 文件夹

- `src`: 包导出的源码类型。
- `dist`: 编译生成的 JavaScript 和声明文件，不要手动修改。
- `node_modules`: 包管理器生成的本地依赖链接和命令入口，不要手动修改。

## 文件

- `package.json`: 包元信息、构建/检查脚本，以及给消费者使用的导出映射。
- `tsconfig.json`: TypeScript 构建配置，用来把 `src` 编译到 `dist`。
- `src/index.ts`: 工作区、Git、终端、语言服务、诊断、项目索引等共享协议类型。

## 边界

这里只放数据结构和少量平台无关的辅助类型。不要把 Electron API、Vue 状态、文件系统行为、LSP 进程管理，或者旧 agent/model/MCP 逻辑放进这个包。
