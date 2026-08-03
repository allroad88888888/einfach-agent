# 插件扩展面产品化蓝图

更新时间：2026-08-03。前置条件：结构优化蓝图 B1–B7 已完成；Core 已支持多实例。

## 目标与边界

把已有的 loop hook、工具与订阅注册能力接入真实 `CoreInstance` 生命周期，使外部包能够在不读取 Core 内部 store 的前提下注册工具、观察状态并调用受限命令。

本计划只覆盖阶段 2 的非 UI 插件面。不实现 `registerRenderer`，不迁移 API key，不改变无插件时的模型、工具并发和持久化行为。

P2.1 已将 `registerTool`、`subscribe` 与插件 disposer 接入真实 Core/run 生命周期；P2.2 已接入 `prepareRequest`；P2.3 已接入 `beforeToolCall` 与 `afterToolCall`。当前生产 loop 尚未消费 `shouldStop`。

## 固定设计约束

- 插件按 Core 实例安装：入口采用 `createCore({ plugins })` 或等价显式安装 API，禁止进程级全局注册。
- 安装期资源和每次 run 资源分层：工具注册与安装 disposer 属于 Core 生命周期；hook 闭包、订阅和 run disposer 属于单次 run，必须在所有 `finally` 路径释放。
- command facade 由顶层 `createCore` 组合并注入当前 Core 的受限命令；`pluginApi` 不得反向 import `commands.ts`。
- 工具重名采取安装前全量预检、原子拒绝策略；不得让插件覆盖宿主工具，也不得在失败后留下部分注册。
- 插件错误必须隔离并产生 trace 证据。是否中止当前 run 由具体 hook 契约明确，不允许静默吞掉后继续执行危险工具。
- 旧 `AgentPlugin` 的兼容行为先由适配层保持；公开稳定 API 在垂直样板验证后再冻结。

## 批次 P2.1 —— Core 插件宿主与生命周期（已完成）

**已完成（`3b5b89c`）**：建立每个 Core 私有的插件安装、预检、卸载和每 run 激活边界。

- 单职责 plugin host 持有安装的插件描述、工具所有权和安装期 disposer；未引入 React 或应用层类型。内置插件集合延迟到 run 激活时加载，避免与 `defaultCore` 的初始化环。
- `createCore({ plugins })` 将插件安装到当前 Core；bootstrap 从该 Core 激活每次 run 的插件，不再硬编码内置插件数组。
- 工具注册前预检宿主与全部插件内的名称冲突；任一冲突均原子拒绝，不留下部分注册。
- bootstrap 绑定订阅；`runToolLoop` 的完成、暂停、异常、abort 与 stale 路径统一解绑。Core 卸载时先释放活跃 run，再注销自己安装的工具并执行安装 disposer。

验收：两个 Core 的插件、工具和订阅完全隔离；卸载后无残留；无插件时请求、工具列表和 trace 保持不变；同名冲突不产生部分安装。

## 批次 P2.2 —— 请求 hook 的真实接线（已完成）

**已完成（`38d2684`）**：让 `prepareRequest` 在一次真实模型请求中生效。

- `RequestDraft` 维持为本轮请求投影，hook 只能改 draft，不会回写会话 `itemsAtom`。
- `prepareRequest` 在 `transformContext` 后、请求 payload 投影与缓存统计前调用；失败时记录 `agent.plugin_prepare_request_failed`，主循环收敛 run 为 `error`。
- 集成测试覆盖普通、断点恢复与计划恢复请求：每次请求只触发一次，marker 出现在真实 fetch body，草稿不会污染会话历史。

验收：外部插件追加 marker 后真实 fetch body 可见；会话项目不变；未安装插件的请求逐字不变；失败 hook 不会留下活跃订阅。

## 批次 P2.3 —— 工具 hook 契约收紧与接线（已完成）

**已完成（`4e2976d`）**：以受限事件和统一执行包装器覆盖工具调用生命周期，保持未安装 hook 时的原路径。

- 公共事件固定为 `callId`、工具名和只读的已验证参数；`afterToolCall` 只接受已完成 `ToolResult` 的白名单补丁，不能改写 `ok` 或 `{ pause }` 控制分支。
- `beforeToolCall` 位于权限和参数校验之后、确认与实际执行之前；阻断或 hook 异常均写入确定结果，既不执行工具也不进入确认。
- 常规、安装 hook 时的批处理和确认恢复均通过同一包装器；确认挂起会记录已执行的 before 标记，恢复时不会重复触发。安装工具生命周期 hook 后按声明顺序串行；未安装时仍走原有并行和串行路径。
- 集成测试覆盖参数规范化、after 结果进入下一轮模型上下文、MCP 阻断、hook 下串行化、确认恢复不重复 before；既有无 hook 并行回归保持通过。

验收：三种路径各触发一次 before/after；阻断不执行；after 的结果进入后续模型上下文；无插件的并行回归保持不变。已由全量测试、TypeScript 检查与生产构建验证。

## 批次 P2.4 —— 停止决策、受限命令与垂直样板

**只做**：完成一个可交付插件的端到端闭环。

- 将 `shouldStop: boolean` 设计为含 run 状态、原因和 checkpoint 语义的显式决定；在契约完成前不把旧槽直接接入 loop。
- 以当前 Core 绑定的最小 command facade 替换手写目标类型；只暴露经过现有运行状态与确认边界的命令，不暴露 store。
- 实现一个非 React 的样板插件，覆盖工具注册、run 观察、一个受限命令、卸载和异常隔离。`registerRenderer` 留作独立 UI 协议任务。

验收：外部包不导入内部 store 即可完成上述能力；卸载无订阅或工具残留；插件异常不会破坏主 run；样板覆盖注册冲突和 Core 隔离。

## 迁移与回归策略

- 先为每个批次补端到端失败用例，再实现最小接线；每项保持一个可撤回 commit。
- 执行 `codegraph affected -q -d 1 <改动文件>`、相关测试、`pnpm build`；批次完成后跑全量 `pnpm test`。
- 新增模块遵循单一职责与行数上限；不得把生命周期、hook 聚合和工具执行塞回同一文件。
- 完成后更新 [项目路线图](ROADMAP.md) 与 [文档导航](README.md)，并将旧的“零消费 hook”说明替换为实际契约。

## 后续边界

- `registerRenderer` 需要 Core item 协议与 React 宿主 registry 的独立设计，不能让 `agent-core` 依赖 React。
- API key 从前端移出、Tauri 凭证与模型代理属于阶段 3；它们不通过插件 API 绕过安全边界。
- 子 Agent 树单一事实源涉及执行图、归档格式和会话 tool result 的迁移，另行立项。
