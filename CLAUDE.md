# CLAUDE.md

本文件是仓库内编码 Agent 的快速工作约定。项目现状和启动方法以 `README.md` 为准，
专题设计入口见 `docs/README.md`。

## 命令

这是 pnpm workspace，`packages/*` 和 `tools/*` 使用 `workspace:*`。不要使用 `npm install`。

- `pnpm install`：安装并链接全部 workspace 包。
- `pnpm dev`：启动 Vite Web 预览。
- `pnpm build`：执行 `tsc -b` 后构建 Vite；这是类型门禁。
- `pnpm test`：Vitest 单次运行。
- `pnpm test:watch`：Vitest watch。
- `pnpm exec vitest run <file>`：运行单个测试文件。
- `pnpm tauri dev` / `pnpm tauri build`：桌面端开发与打包。
- `cargo test --manifest-path apps/desktop/Cargo.toml`：Rust 桥测试。

Vitest 使用 jsdom 和 `apps/web/src/test/setup.ts`。`fileParallelism: false` 是有意设置：
abort registry、默认 core 和部分会话缓存仍包含进程内共享状态。组件测试应使用
`apps/web/src/test/renderWithStore.tsx` 提供的隔离 store；IndexedDB 测试使用 `fake-indexeddb`。

## 配置

`apps/web/src/main.tsx` 通过 `configureCommands` 注入：

- `VITE_DEEPSEEK_API_KEY`
- `VITE_GLM_API_KEY`

模型请求从前端直接发往供应商接口。没有对应 Key 时，该供应商调用会进入 error 状态。
不要假设 `.env.example` 之外的 `VITE_*` 变量已经接线。

## 当前结构

- `apps/web/src/main.tsx`：默认应用装配；注册标准工具、配置模型、选择持久化和观测 driver。
- `apps/web/src/agentNew/ui/`：React UI，包含会话、消息、计划、确认、子 Agent 树和输入区。
- `apps/desktop/`：Rust/Tauri 的 shell、workspace、Git、dialog 与 SQLite 实现。
- `packages/agent-ai/`：DeepSeek/GLM 请求、流式响应和重试。
- `packages/agent-core/`：Agent Runtime 与所有核心状态。
- `tools/{shell,fs,interaction,planning,skills,agents}/`：六个具体工具域。
- `tools/standard/`：标准工具聚合包，提供 `registerStandardTools`。
- `docs/`：当前说明和仍在推进的演进蓝图。

依赖必须维持：

```text
agent-ai ← agent-core ← tools-* ← tools(meta) ← app
```

`agent-core` 不得反向依赖任何具体 `tools-*` 包。

## 状态与 UI 边界

默认运行时使用一个 `defaultCore`。它持有 root store、每会话 store 缓存、工具 registry、
abort registry 和运行时配置。`createCore()` 可创建隔离实例；默认实例本身不自动安装工具，
应用和测试入口负责调用 `registerStandardTools`。

- root store 只放跨会话状态：会话元数据与当前会话 ID。
- 每个 session 有独立 Einfach store，保存 items、run、checkpoint、plan 和瞬态 UI 状态。
- UI 只允许读取 atom、调用 `runtime/commands.ts` 暴露的命令。
- UI 不直接调用 writer、不 setter 业务 atom、不持有 runtime store。
- writer 和 await 后回写必须保留 ghost guard、runId stale guard 与 AbortSignal 检查。
- checkpoint 保存 items 的不可变快照，不能用原地修改破坏历史。

## 运行链路

`sendMessage` 创建 run 并进入 `modelRun.ts`：

1. 写入用户消息与 running 状态。
2. 组装 system prompt、上下文、工具摘要和 `request_tool_schema`。
3. 模型按需请求完整工具 schema。
4. 工具经 registry 校验后，通过受限 `ToolContext` 执行。
5. 普通工具结果回填并继续循环；ask-user、计划审批或危险工具确认会暂停。
6. 完成后提交 checkpoint，并通过 persistence bridge 落盘。

工具不得直接 import store/atom 来获得额外能力。文件、shell、计划、渲染、委派等副作用必须使用
`ToolContext` 暴露的能力，确保 workspace confinement、权限确认、stale guard 和审计仍然生效。

## 持久化与运行环境

- Web：会话/历史和 trace 使用 IndexedDB。
- Tauri：会话/历史和 trace 使用 SQLite，文件/shell/Git 通过 Rust command 执行。
- `server` 工具在非 Tauri 环境中不会暴露给模型。
- `.agent-archive/` 保存子 Agent 长期归档与索引，不应提交到 Git。

## 测试与修改约定

- TypeScript strict 开启；完成修改至少运行相关测试和 `pnpm build`。
- runtime/state 修改优先补充 colocated `*.test.ts(x)`。
- 在 `apps/` 或 `packages/` 新增非测试源文件时，必须同时添加对应测试；修改核心控制流时必须添加聚焦的回归用例；业务行为改动应补充测试。
- 模型 adapter 的“除 AbortError 外返回 fallback、不向 UI 抛出”是有意契约。
- 新工具放到对应 `tools/<domain>/src/<tool-name>/`，同目录包含实现、说明和测试，
  再由域包 registrar 注册。
- 用户可见的助手文案保持中文。
- 已完成的阶段 PLAN 只保留在 Git 历史中。判断现状时以当前代码、测试和 `docs/README.md`
  指向的文档为准。
