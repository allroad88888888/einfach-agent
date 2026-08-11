# MCP 重设计 · Issue 树

按 skill `issue-tree-workflow` 执行：一个 issue = 一次 commit，主会话派活并亲自验收。

## 背景：现状的四个病灶

1. **冷启动不连接**。`initializeMcpSettings()` / `hydrateMcpSettings()` 只在
   `apps/web/src/agentNew/ui/SettingsDialog.tsx` 的 `useEffect` 里跑，而该组件被
   `SettingsCenter.tsx` 懒挂载——用户不点一次「设置」，MCP 运行时就不存在，
   `autoConnect` 是空头支票。
2. **stdio 永远手动重连**。`autoConnect` 在 `apps/web/src/mcp/config.ts` 建配置时、
   读盘 sanitize 时、`service.ts` hydrate 时被写死 false 共三次。
3. **断线不自愈**。`tools/mcp/src/clientManager.ts` 里没有任何退避、重试或 keepalive；
   意外关闭直接 `failClosed` → 注销全部工具 → 停在 `error`。
4. **工具集可在 run 中途变形**。`list_changed` 与断线会立即改全局 `toolRegistry`，
   正在跑的 run 手里的工具清单当场失效。

## 目标形态

- 连接归属**进程级**，不是会话级：装配在 app 启动时完成。
- **常驻 + 按需混合**：用户标常驻的服务启动即连；其余以「服务」为单位进 manifest，
  模型用 `mcp_connect` 按需打开。
- 按需模式要能工作，**必须缓存每个服务上次的工具名清单**，落在
  `~/.web-agent/config.json`，否则模型无从知道该连哪个服务。
- 连接工具的入参**只能是已配置服务的 ID**，绝不接受 URL 或 command——
  否则提示注入可让模型连上攻击者控制的服务。

---

## A · 配置存储底座

### A1 · 把 `ModelCredentialStore` 泛化为通用配置 store

- **依赖**：—
- **改动面**：`apps/desktop/src/model_credential_config.rs`
- **判据**：模型凭据读写行为与权限（目录 `0700`、文件 `0600`）不变；新增按 section
  读写任意 JSON 的 API；`cargo test --manifest-path apps/desktop/Cargo.toml` 通过
- **模型**：opus（触及凭据存储与文件权限）
- **状态**：TODO

### A2 · 新增读写 `mcp` 配置段的 Tauri command

- **依赖**：A1
- **改动面**：`apps/desktop/src/mcp.rs`（或新建 `mcp_config.rs`）、`lib.rs` 注册
- **判据**：command 可读写 `config.json` 的 `mcp` 段并保留其它顶层键；Rust 测试覆盖
  空文件、损坏 JSON、并发写三种情况
- **模型**：sonnet
- **状态**：TODO

### A3 · 前端侧 `mcp` 配置段读写封装

- **依赖**：A2
- **改动面**：`apps/web/src/mcp/persistence.ts` 旁新增桌面 storage 实现
- **判据**：非 Tauri 环境自动退回现有 localStorage 实现；`pnpm exec vitest run apps/web/src/mcp` 通过
- **模型**：sonnet
- **状态**：TODO

---

## B · 工具名缓存

### B1 · 缓存数据结构与读写

- **依赖**：A3
- **改动面**：`apps/web/src/mcp/` 新增 `toolNameCache.ts`
- **判据**：按 serverId 存 `{ toolNames, cachedAt }`；有条数上限与总长度上限；有单测
- **模型**：sonnet
- **状态**：TODO

### B2 · reconcile 成功后写缓存

- **依赖**：B1
- **改动面**：`apps/web/src/mcp/service.ts`（订阅 manager snapshot 后写）
- **判据**：**缓存写入必须留在 app 层**——`tools/mcp` 与 core 都不得碰磁盘；
  连接成功后缓存被更新，断开后缓存保留
- **模型**：opus（边界决定，写错就把磁盘依赖漏进 core）
- **状态**：TODO

### B3 · 冷启动把缓存读进服务视图

- **依赖**：B1
- **改动面**：`apps/web/src/mcp/state.ts`、`service.ts`
- **判据**：未连接的服务在 UI 上能显示「上次可用工具 N 个」
- **模型**：sonnet
- **状态**：TODO

---

## C · 装配位置修正（最高性价比，建议先做）

### C1 · MCP 装配从设置弹窗移到应用启动

- **依赖**：—
- **改动面**：`apps/web/src/mcp/initialize.ts`、`apps/web/src/main.tsx`
- **判据**：不打开设置弹窗，冷启动后 `autoConnect` 的 HTTP 服务自动连上且工具进
  registry；装配不阻塞首屏渲染
- **模型**：sonnet
- **状态**：TODO

### C2 · 设置弹窗只保留编辑职责

- **依赖**：C1
- **改动面**：`apps/web/src/agentNew/ui/SettingsDialog.tsx`
- **判据**：删除 `initializeMcpSettings()` / `hydrateMcpSettings()` 调用后，
  设置面板功能不变；`pnpm exec vitest run apps/web/src/agentNew/ui` 通过
- **模型**：sonnet
- **状态**：TODO

### C3 · 设置中心 UI 状态搬出 mcp 模块

- **依赖**：—
- **改动面**：`apps/web/src/mcp/state.ts` 的 `settingsCenterOpenAtom` /
  `settingsCenterTabAtom` → `apps/web/src/settings/`
- **判据**：MCP 模块不再定义与 MCP 无关的全局 UI 状态；引用点全部更新；`pnpm build` 通过
- **模型**：sonnet
- **状态**：TODO

---

## D · 连接状态机

### D1 · 拆开 `error` 的两种语义

- **依赖**：—
- **改动面**：`tools/mcp/src/types.ts` 的 `McpServerStatus`、`clientManager.ts`
- **判据**：`'reconnecting'` = 暂时失败正在重试，`'error'` = 永久失败需人工；
  认证失败 / 命令不存在 / 配置非法归入永久
- **模型**：sonnet
- **状态**：TODO

### D2 · 断线退避重连

- **依赖**：D1
- **改动面**：`tools/mcp/src/clientManager.ts` 的 `failClosed`
- **判据**：指数退避 1s→2s→4s→…封顶 30s，有最大次数，可被手动重连打断；
  **重试必须沿用现有的连接身份世代检查**，旧连接的回调不得污染新连接
- **模型**：opus（并发与生命周期，这是全仓最容易写出竞态的地方）
- **状态**：TODO

### D3 · keepalive ping

- **依赖**：D1
- **改动面**：`tools/mcp/src/clientManager.ts`
- **判据**：静默连接能在下次真实调用前发现已死并触发 D2 的重连
- **模型**：opus
- **状态**：TODO

### D4 · UI 展示重试状态

- **依赖**：D1
- **改动面**：`apps/web/src/agentNew/ui/` 的 MCP 设置面板
- **判据**：重试中与永久失败在界面上可区分，永久失败给出原因
- **模型**：sonnet
- **状态**：TODO

---

## E · run 工具集快照

### E1 · run 开始时固定工具集 epoch

- **依赖**：—
- **改动面**：`packages/agent-core/src/runtime/runToolLoop.ts`、`tools/toolRegistry.ts`
- **判据**：复用现有的 `registrationVersion` 原语；run 期间 registry 变化不改变本 run
  已组装的清单
- **模型**：opus
- **状态**：TODO

### E2 · run 期间只增不减

- **依赖**：E1
- **改动面**：`packages/agent-core/src/runtime/toolCallGate.ts`、`toolCallExecutor.ts`
- **判据**：run 中新注册的工具可用；被移除的工具被调用时返回结构化错误
  （「该工具所属的 MCP 服务在本轮已断开」），而不是静默消失或抛异常
- **模型**：opus
- **状态**：TODO

### E3 · 待确认工具的版本校验并入 epoch

- **依赖**：E1
- **改动面**：`packages/agent-core/src/runtime/commands/runCommands.ts`
- **判据**：现有 `registrationVersion` 判断收敛到统一的 epoch 机制，行为不回退
- **模型**：opus
- **状态**：TODO

---

## F · `mcp_connect` 工具

### F1 · 工具与注入式 registrar

- **依赖**：—
- **改动面**：新增 `tools/mcp/src/connect-mcp-server/`（实现 + 说明 + 测试同目录）
- **判据**：`createMcpConnectTool(manager)` + `registerMcpTools(registry, { manager })`。
  **这是第一个需要注入运行时依赖的工具域，后续会被抄**，签名要立得住
- **模型**：opus
- **状态**：TODO

### F2 · 入参限定为已配置的 serverId

- **依赖**：F1
- **改动面**：`tools/mcp/src/connect-mcp-server/`
- **判据**：inputSchema 是已配置服务 ID 的枚举；**传 URL 或 command 一律拒绝**；
  有针对提示注入场景的测试
- **模型**：opus（安全硬约束）
- **状态**：TODO

### F3 · 按参数分级接入危险工具确认

- **依赖**：F1
- **改动面**：`packages/agent-core/src/runtime/dangerousTools.ts`
- **判据**：serverId 指向 stdio → `dangerous`（走现有确认 UI，提示将执行的命令）；
  指向 HTTP → `safe`。沿用 `classifyToolRisk` 已有的按参数分级能力
- **模型**：opus
- **状态**：TODO

### F4 · manifest 里带上缓存的工具清单

- **依赖**：F1、B1
- **改动面**：`tools/mcp/src/connect-mcp-server/`
- **判据**：未连接服务在工具描述里列出上次可用的工具名（有长度上限）。
  **这条不做，模型不知道该连谁，整个按需模式失效**
- **模型**：sonnet
- **状态**：TODO

### F5 · 连接失败的可重试性分类

- **依赖**：F1
- **改动面**：`tools/mcp/src/connect-mcp-server/`
- **判据**：配置错误 / 命令不存在 → `retryable: false`；网络抖动 → `retryable: true`；
  连接有独立超时，不吃工具调用的 120s
- **模型**：sonnet
- **状态**：TODO

---

## G · 首个 run 的连接 barrier

### G1 · 组装工具清单前等待首连 settle

- **依赖**：C1
- **改动面**：`packages/agent-core/src/runtime/runToolLoop.ts` 或其 bootstrap 环节
- **判据**：只在**首个** run 生效，超时（建议 3s）后带着已连上的服务继续；
  消除「第一条消息看不到 MCP 工具、第二条才看到」
- **模型**：opus（run 生命周期）
- **状态**：TODO

---

## H · stdio 自动连接解禁

### H1 · 移除三处硬编码 false

- **依赖**：F3
- **改动面**：`apps/web/src/mcp/config.ts`、`apps/web/src/mcp/service.ts`
- **判据**：stdio 的 `autoConnect` 可持久化为 true
- **模型**：sonnet
- **状态**：TODO

### H2 · 每服务 opt-in + 首次开启确认

- **依赖**：H1
- **改动面**：`apps/web/src/mcp/service.ts`、设置面板
- **判据**：为某 stdio 服务首次打开自动连接时，弹一次「每次启动都会执行
  `<command> <args>`」确认；确认结果落配置，之后不再重复问
- **模型**：opus（安全边界）
- **状态**：TODO

---

## 未决（决策落地前不开工，不指派模型）

- **凭据支持**。`config.ts` 的 `toManagerConfig` 主动丢弃 `headers` / `env`，
  `parseArgsText` 还把疑似 token 的启动参数判为错误。**现在任何需要认证的 MCP 服务都接不上。**
  要不要做、走静态 token 还是 OAuth，未定。做 OAuth 的话 D1 的状态机需要预留 `needs_auth`。
- **异步长任务**。`toolAdapter.ts` 拒绝 `taskSupport: 'required'` 的服务，且每次调用硬超时
  120 秒。要支持跑得久的工具就得动 run 的暂停/恢复模型，工作量大于 A–H 之和。
- **MCP 配置本体是否迁出 localStorage**。缓存进了 `~/.web-agent/config.json`，
  而服务配置仍在 `web-agent.mcp-servers.v1`，形成两处存储。是否一并迁移、存量怎么迁，未定。
