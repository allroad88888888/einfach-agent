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
  模型用 `connect_mcp_server` 按需打开。
- 按需模式要能工作，**必须缓存每个服务的工具清单**，落在 `~/.web-agent/config.json`，
  否则模型无从知道该连哪个服务。清单的主要来源是**安装时的一次性探测**——添加服务就连一次，
  顺带验证配置、取得授权，并把连接期硬失败（工具数超限、名字碰撞、`taskSupport` 不支持）
  从对话中途提前到表单上。
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
- **状态**：DONE 543b239

### A2 · 新增读写 `mcp` 配置段的 Tauri command

- **依赖**：A1
- **改动面**：`apps/desktop/src/mcp.rs`（或新建 `mcp_config.rs`）、`lib.rs` 注册
- **判据**：command 可读写 `config.json` 的 `mcp` 段并保留其它顶层键；Rust 测试覆盖
  空文件、损坏 JSON、并发写三种情况
- **模型**：sonnet
- **状态**：DONE 84a349a

### A3 · 前端侧 `mcp` 配置段读写封装

- **依赖**：A2
- **改动面**：`apps/web/src/mcp/persistence.ts` 旁新增桌面 storage 实现
- **判据**：非 Tauri 环境自动退回现有 localStorage 实现；`pnpm exec vitest run apps/web/src/mcp` 通过
- **模型**：sonnet
- **状态**：TODO

---

## B · 工具清单缓存

> 缓存的**主要来源是安装时的探测**，不是使用中的顺手记录。添加服务的那一刻就该连一次、
> 取回工具清单——同时还验证了配置、拿到了授权、把连接期硬失败提前到了表单上。

### B1 · 缓存数据结构与读写

- **依赖**：A3
- **改动面**：`apps/web/src/mcp/` 新增 `toolNameCache.ts`
- **判据**：按 serverId 存 `{ tools: [{ name, description }], toolCount, cachedAt, probeStatus }`；
  有条数上限与总长度上限；有单测。
  **只缓存名字与短描述，不缓存 `inputSchema`**——单个 schema 上限就有 128 KB，
  且 schema 属于 `request_tool_schema` 那一层，而那一层要求工具真的已注册（= 已连接）。
  缓存 schema 会诱使实现让模型直接调未连接的工具，破坏惰性加载的分层
- **模型**：sonnet
- **状态**：TODO

### B2 · 安装即探测

- **依赖**：B1
- **改动面**：`apps/web/src/mcp/service.ts` 的 `submitDraft` / `importJson`
- **判据**：新增或导入服务时做一次性连接探测并写缓存。
  **探测失败不得阻断保存**——配置照存，标记 `probeStatus: 'failed'` 并在界面显著提示。
  批量导入后台逐个探测且有可见进度，不阻塞界面。
  现状对照：`buildPersistedMcpConfig` 对 stdio 强制 `autoConnect: false`、`importJson` 对
  全部导入项写死 false，所以今天这两条路径添加的服务**从不验证**。
  **排序约束：stdio 的探测会真的起子进程，因此它不得先于 H2 的确认门上线。**
  本 issue 只交付 HTTP 探测，stdio 探测路径留桩，由 H2 一起开
- **模型**：opus（同时是授权时机与 stdio 进程确认的落点）
- **状态**：TODO

### B3 · 正常连接成功后刷新缓存

- **依赖**：B2
- **改动面**：`apps/web/src/mcp/service.ts`（订阅 manager snapshot 后写）
- **判据**：与 B2 共用同一个写入点。**缓存写入必须留在 app 层**——`tools/mcp` 与 core
  都不得碰磁盘；断开后缓存保留
- **模型**：opus（边界决定，写错就把磁盘依赖漏进 core）
- **状态**：TODO

### B4 · 缓存过期语义

- **依赖**：B1
- **改动面**：`apps/web/src/mcp/toolNameCache.ts`、`packages/agent-core/src/tools/schemaResult.ts`
- **判据**：清单一律呈现为「上次已知（`cachedAt`）」而非断言，连上后以真实清单为准。
  模型跳过 `connect_mcp_server` 直接点名调用缓存里的工具时，接进 `schemaResult` 现有的
  「未加载工具」路径，返回「该工具所属服务未连接，请先连接」，而不是 unknown tool
- **模型**：opus
- **状态**：TODO

### B5 · 冷启动把缓存读进服务视图

- **依赖**：B1
- **改动面**：`apps/web/src/mcp/state.ts`、`service.ts`
- **判据**：未连接的服务在 UI 上显示「上次可用工具 N 个」与探测时间
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
- **状态**：DONE e99d1fa

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
- **状态**：DONE 53fc83f

---

## D · 连接状态机

### D1 · 拆开 `error` 的两种语义

- **依赖**：—
- **改动面**：`tools/mcp/src/types.ts` 的 `McpServerStatus`、`clientManager.ts`
- **判据**：`'reconnecting'` = 暂时失败正在重试，`'error'` = 永久失败需人工；
  认证失败 / 命令不存在 / 配置非法归入永久
- **模型**：sonnet
- **状态**：DONE ff9ce23

### D5 · stdio 失败分类改用结构化 `kind`，不再匹配文案

- **依赖**：D1
- **改动面**：`tools/mcp/src/failureClassification.ts`、
  `apps/web/src/mcp/tauriStdioConnector.ts`，必要时 `apps/desktop/src/mcp.rs`
- **判据**：stdio 的 spawn 失败靠 `McpCommandError.kind` 判定，不再靠
  `/enoent|command not found|is not recognized/i` 这类文案正则。Rust 侧若没有对应的 kind
  就补一个（现有 kind：`rpc_error` / `not_connected` / `stale_session` / `process_exited` /
  `transport_closed` / `transport_error` / `process_error` / `worker_failed`）。
  要有测试证明改 Rust 文案不会让分类退化
- **模型**：opus（跨 Rust/TS 契约）
- **状态**：TODO

> **为什么必须排在 D2 之前**：D1 的分类器默认落到「暂时失败」。
> `tools/mcp` 现在匹配的是 `apps/desktop/src/mcp.rs` 里 `McpSession::spawn` 的字面文案——
> 一个未声明的跨包契约。改动 Rust 文案会让永久失败静默降级成暂时失败，
> **D2 上线后就变成对一个永远连不上的服务无限退避重试**。
> 而结构化的 `kind` 字段本来就存在，`tauriStdioConnector.ts` 里已经在消费它。

### D2 · 断线退避重连

- **依赖**：D1、D5
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
- **状态**：DONE c0837b2

### E2 · run 期间只增不减

- **依赖**：E1
- **改动面**：`packages/agent-core/src/runtime/toolCallGate.ts`、`toolCallExecutor.ts`
- **判据**：run 中新注册的工具可用；被移除的工具被调用时返回结构化错误
  （「该工具所属的 MCP 服务在本轮已断开」），而不是静默消失或抛异常
- **模型**：opus
- **状态**：DOING

### E3 · 待确认工具的版本校验并入 epoch

- **依赖**：E1
- **改动面**：`packages/agent-core/src/runtime/commands/runCommands.ts`
- **判据**：现有 `registrationVersion` 判断收敛到统一的 epoch 机制，行为不回退
- **模型**：opus
- **状态**：TODO

---

## F · `connect_mcp_server` 工具

### F1 · 工具与注入式 registrar

- **依赖**：C1（连接工具需要一个活的 `McpClientManager`，而它只在启动装配后才存在——
  装配还挂在设置弹窗上时，这个工具根本注册不出来）
- **改动面**：新增 `tools/mcp/src/connect-mcp-server/`（实现 + 说明 + 测试同目录）
- **判据**：`createMcpConnectTool(manager)` + `registerMcpTools(registry, { manager })`。
  **这是第一个需要注入运行时依赖的工具域，后续会被抄**，签名要立得住
- **模型**：opus
- **状态**：DONE 4062ad0

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

- **依赖**：F1、B2
- **改动面**：`tools/mcp/src/connect-mcp-server/`
- **判据**：未连接服务在工具描述里列出缓存的工具名与短描述（有长度上限），
  并标注 `cachedAt`。因为 B2 保证了**每个已配置服务在安装时就有清单**，
  这里不是尽力而为的补充信息，而是模型做连接决策的唯一依据。
  **这条不做，整个按需模式失效**
- **模型**：opus（决定模型能否找到工具，是 F 分支的承重项）
- **状态**：TODO

### F6 · 让 manager 认识「已配置但未连接」的服务

- **依赖**：F1、**F3（安全前置，见下）**
- **改动面**：`tools/mcp/src/clientManager.ts`（新增只登记不连接的入口）、
  `apps/web/src/mcp/service.ts` 的 hydrate
- **判据**：冷启动后，配置里的**全部**服务都能被 `connect_mcp_server` 找到，
  而不只是 `autoConnect` 的那批
- **模型**：opus（要给 manager 加一个新的记录状态，会牵动世代检查与 snapshot 语义）
- **状态**：TODO

> **为什么按需模式现在还跑不通**：`manager.get(id)` 只认有 record 的服务，
> 而 record 只在 `connect(config)` 被调用过之后才存在。`service.ts` 的 hydrate
> 只对 `autoConnect` 的 HTTP 服务调 `connect`，所以「已配置但从未连过」的服务
> 在 manager 里根本不存在，`connect_mcp_server` 对它们一律返回
> `MCP_SERVER_NOT_CONFIGURED`。F2 收窄入参为 enum 时会撞上同一个数据源问题。
>
> **为什么它必须排在 F3 之后**：stdio 的 `autoConnect` 被写死 false，所以 stdio 服务
> 现在**永远没有 record**——这恰好是当前唯一挡着「模型调一次工具就起子进程」的东西。
> F6 一旦让它们可达，而 F3 的确认门还没上，就等于开了一条无需确认的起进程路径。
> 这条约束和 B2 / H2 那条是同一种：**能力解锁必须与门禁同时或滞后落地。**

### F5 · 连接失败的可重试性分类

- **依赖**：F1
- **改动面**：`tools/mcp/src/connect-mcp-server/`
- **判据**：配置错误 / 命令不存在 → `retryable: false`；网络抖动 → `retryable: true`；
  连接有独立超时，不吃工具调用的 120s
- **模型**：sonnet
- **状态**：TODO

---

## G · 首个 run 的连接 barrier（**建议不做**）

### G1 · 组装工具清单前等待首连 settle

- **依赖**：C1、F4
- **改动面**：`packages/agent-core/src/runtime/runToolLoop.ts` 或其 bootstrap 环节
- **判据**：只在**首个** run 生效，超时（建议 3s）后带着已连上的服务继续
- **模型**：sonnet
- **状态**：TODO（**低优先，建议排到最后再决定要不要做**）

**原立项理由已被 B2 + F4 消解。** 当初要这道 barrier 是为了消除「第一条消息看不到 MCP
工具、第二条才看到」；但既然每个已配置服务在安装时就有缓存清单，模型在任何时刻都能看到
全部工具，无所谓连没连上——没有东西需要等。

剩下的唯一价值是省一次无谓调用：常驻服务还在连接途中时，模型可能对一个 200ms 后就会连上的
服务白调一次 `connect_mcp_server`。**代价是给 run 生命周期加一条阻塞路径**，而 run 生命周期是这个
仓库最不该随便加分支的地方。建议先不做，等实际观测到这种白调再说。

---

## H · stdio 自动连接解禁

### H1 · 移除三处硬编码 false

- **依赖**：F3
- **改动面**：`apps/web/src/mcp/config.ts`、`apps/web/src/mcp/service.ts`
- **判据**：stdio 的 `autoConnect` 可持久化为 true
- **模型**：sonnet
- **状态**：TODO

### H2 · 起进程的确认前移到安装探测

- **依赖**：H1、B2
- **改动面**：`apps/web/src/mcp/service.ts`、设置面板
- **判据**：确认发生在**首次真正起进程**的时刻，也就是 B2 的安装探测——
  弹一次「将执行 `<command> <args>`，之后每次启动都会自动执行」，
  确认结果落配置；此后开关自动连接不再重复问
- **模型**：opus（安全边界）
- **状态**：TODO

---

## 未决（决策落地前不开工，不指派模型）

- **凭据支持**（**已升级为 B2 的实际阻塞项**）。`config.ts` 的 `toManagerConfig` 主动丢弃
  `headers` / `env`，`parseArgsText` 还把疑似 token 的启动参数判为错误。
  **现在任何需要认证的 MCP 服务都接不上。**
  安装即探测把这件事从「以后再说」变成「立刻可见」：所有需要认证的服务在 B2 里都会
  探测失败、`probeStatus: 'failed'`、缓存为空——于是 F4 没清单可给、按需模式对这类服务完全失效。
  换句话说 **B2 做完就会暴露这个洞**。要不要做、走静态 token 还是 OAuth，未定；
  做 OAuth 的话 D1 的状态机需要预留 `needs_auth`。

- **要不要保留显式 `connect_mcp_server`**。既然安装时已拿到全部工具清单，理论上可以取消这个工具：
  把所有缓存工具作为 stub 直接注册进 registry，模型照常调 `mcp__github__create_issue`，
  运行时发现未连接就先透明连上再执行。
  取舍是明确的——透明模式**省一轮但费 context**（20 服务 × 20 工具 = 400 条摘要进每次请求），
  显式模式**省 context 但多一轮**，且起进程的确认能落在一次语义明确的调用上，
  而不是突然插进一次业务调用里。
  当前 F 分支按**显式**设计，理由是本仓库已经为了 context 经济做了惰性 schema（`request_tool_schema`），
  透明模式与那个取向相悖。要改成透明模式，F1–F5 整支重写。
- **异步长任务**。`toolAdapter.ts` 拒绝 `taskSupport: 'required'` 的服务，且每次调用硬超时
  120 秒。要支持跑得久的工具就得动 run 的暂停/恢复模型，工作量大于 A–H 之和。
- **MCP 配置本体是否迁出 localStorage**。缓存进了 `~/.web-agent/config.json`，
  而服务配置仍在 `web-agent.mcp-servers.v1`，形成两处存储。是否一并迁移、存量怎么迁，未定。
