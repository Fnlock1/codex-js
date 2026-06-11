# packages 目录说明

这里存放 Qoder Open 工作区内的共享包，目前只保留桌面编辑器需要的公共类型包。

## 文件夹

- `shared`: 共享 TypeScript 包，提供 Electron main、preload、Vue renderer 之间共用的可序列化编辑器协议类型。

## 生成目录和本地目录

下面这些目录或文件可能会在安装依赖、构建后出现，但它们不是源码，不要手动修改：

- `shared/dist`: 由 `shared/src` 编译生成的构建产物。
- `shared/node_modules`: 包管理器生成的依赖链接和命令入口。
- `shared/tsconfig.tsbuildinfo`: TypeScript 增量构建缓存。

## 当前规则

`packages` 应保持轻量、平台无关。除非产品方向明确改变，否则不要在这里重新加入 AI agent、model provider、MCP、tool-call loop、Quest/Assistant 相关代码。
