# Core 抽离 + 插件机制蓝图（v1）

> 文档状态：演进蓝图，已部分实施。当前运行行为以
> [核心运行时流程](core-runtime-flow.md) 和 `packages/agent-core` 代码为准；UI renderer
> 边界以[插件 UI Renderer 协议蓝图](plugin-renderer-protocol-blueprint.md)为准。

目标是把运行时持续收敛为「**薄 core + 插件**」。第一轮 workspace 抽包和 hook 切缝已经完成；
下文仍保留目标形态及未完成的插件扩展面。

对应现有实现：

- `packages/agent-core/src/runtime/modelRun.ts` —— 模型 run 与插件 hook 装配入口。
- `packages/agent-core/src/runtime/core/` —— `CoreInstance`、`createCore()`、Plugin API 与 loop hooks。
- `packages/agent-core/src/state/` —— root/session store、atoms 和 guarded writers。
- `packages/agent-core/src/tools/` —— 工具抽象、registry 和 lazy loading。
- `packages/agent-core/src/runtime/contextCompaction.ts` —— 上下文压缩实现。
- `packages/agent-core/src/subagents/` —— 树形子 Agent runtime。
- `tools/*` —— 从 Core 分离出的标准工具实现与聚合包。

---

## 决策先行

- **状态核心是脊柱。** 插件不穿状态参数，直接 `getter(atom)`；运行时句柄就是 store。插件与运行时**平权**——同样的 store、同样的 getter/setter。
- **裸 setter。** 插件拿 `store.setter`，不包 guarded-writer facade。`isCurrent()` 放在 ctx 上，只在「await 之后再写」时自查；循环内 hook 由 loop 的守卫覆盖，零仪式。不可变是**约定**（atom 值标 `readonly`，dev 可选 freeze）。
- **观察 = 订阅 atom；拦截 = hook 槽。** einfach atom 本身可订阅，观察型插件不需要独立事件总线；只有能 block/改写的拦截才需要显式 hook 槽 + 拿 store。
- **薄 loop + 单槽 hook → 多订阅 fan-out。** core loop 只有单槽 hook；插件层把每个单槽多路复用成多订阅（带返回值即拦截）。core 永远不认识插件。
- **工具 `ToolContext` 保持窄。** 工具是 LLM 可调能力，不塞 store；需要广状态的是编排层插件。
- **先立缝，后拆包。** 第一轮曾在旧 `src/agentNew/` 原地立起 CoreCtx/PluginApi/薄 loop，
  当前 Web 宿主已迁至 `apps/web/src/agentNew/`；后续仍按“先稳定边界，再物理拆包”推进。
- **不学 pi 的四样**：子进程 subagent（我们是进程内树）、穿参风格（我们走 store）、harness 焊进 core（我们把 session/skills/compaction 做成插件）、数组状态（我们是 store + atom）。

---

## 一、分层拓扑（物理拆包是最后一步）

严格单向依赖：

```
*-ai          provider 抽象 + 重试（api/modelApi + deepseek/glm）—— 纯，已就位
*-core        状态核心(store/atoms/writers) + 薄 loop + tool registry
              + ToolContext + PluginApi + 事件投影。einfach 在这里，是皇冠。
*-plugin-*     富能力做成插件包：subagents / planning / evaluation / compaction / resilience
consumers     web(React：读 atom + 注册 renderer) / 未来 server(RPC) / cli
```

`*-core` 内部再分两层（借 pi 的 loop/harness 分法，但更干净）：
- **loop 层**：`runAgentLoop(ctx, hooks)` —— 纯引擎，不硬编码任何主张。
- **assembly 层**：把注册进来的插件聚合成 `hooks`，装配一次 run。

---

## 二、运行时句柄 CoreCtx（PX1）

每个 hook / 插件动作在运行时拿到的**唯一**句柄。状态一律从这里的 store 取。

```ts
interface CoreCtx {
  readonly sessionId: string
  readonly runId: string
  readonly signal: AbortSignal
  readonly store: SessionStore   // getter/setter 覆盖会话原子（itemsAtom/runAtom/checkpointsAtom/...）
  readonly root: RootStore       // 跨会话（sessionsAtom / activeSessionIdAtom）
  /** ghost + stale-run 双查。只有「await 之后再写」的异步插件需要调；循环内 hook 不需要。 */
  isCurrent(): boolean
}
```

- **读**：`ctx.store.getter(itemsAtom)` / `ctx.root.getter(sessionsAtom)[ctx.sessionId]`，随取随用。
- **写**：`ctx.store.setter(atom, next)` 裸给。异步写前 `if (!ctx.isCurrent()) return`。
- `isCurrent()` = 现有 `isCurrentRun(id, runId)` 的搬迁：`root.getter(sessionsAtom)[id]` 存在 **且** `store.getter(runAtom)?.runId === runId`。

---

## 三、插件与注册面 PluginApi（PX2）

插件是 `(api: PluginApi) => void | Dispose`。`api` 是**装配期**的注册面；运行时行为通过它注册的
工具、订阅与 hook 生效。React renderer 不属于 Core `PluginApi`。

```ts
type AgentPlugin = (api: PluginApi) => void | (() => void)

interface PluginApi {
  // 能力注册（累积进注册表，core 去读）
  registerTool(tool: Tool): void
  registerCommand(name: string, cmd: Command): void

  // 拦截型 hook（单槽 → 多订阅 fan-out；带返回值即拦截）
  hook<K extends keyof LoopHooks>(name: K, fn: LoopHooks[K]): void

  // 观察型:直接订阅 atom（就是事件流，不另造总线）
  subscribe<T>(atom: Atom<T>, fn: (v: T, ctx: CoreCtx) => void): void

  // 命令式动作 = 复用现有 commands（自解析 store，天然实例安全）
  readonly commands: CommandApi   // sendMessage / answerQuestion / revertToTurn / ...
}
```

上面曾提出的 `registerRenderer(itemType, render)` 已废弃：它会让 Core 公共 API 依赖 React。
renderer registry 由 React 宿主按 root 维护，完整协议与迁移顺序见
[插件 UI Renderer 协议蓝图](plugin-renderer-protocol-blueprint.md)。

**fan-out 语义**（插件层的活，core 不管）：
- 同名 hook 多次 `hook()` → 按注册序组合成一个复合 hook 交给 loop。
- 拦截合并借 pi 的字段级覆盖：`beforeToolCall` 第一个 `{block:true}` 胜；`afterToolCall` 逐字段覆盖，omit 保留原值。

---

## 四、薄 loop 的 hook 槽 LoopHooks（PX3）

`runAgentLoop` 缩成引擎，吃一个 `hooks`。每个槽收 `CoreCtx` +「此刻还没进 store 的瞬时数据」。

```ts
interface LoopHooks {
  /** 组请求前变换上下文（压缩挂这）。状态从 ctx.store 读，不穿 messages。 */
  transformContext?(ctx: CoreCtx): void | Promise<void>
  /** 发请求前改 settings（模型迁移挂这）。 */
  prepareRequest?(ctx: CoreCtx, req: MutableRequest): void
  /** 工具执行前（schema 校验 / 确认门 / 危险门挂这）。返回 {block} 拦截。 */
  beforeToolCall?(ctx: CoreCtx, ev: { toolCall: AgentToolCall; args: unknown }): BeforeToolResult | Promise<...>
  /** 工具执行后（改写结果 / 记录挂这）。 */
  afterToolCall?(ctx: CoreCtx, ev: { toolCall; result: ToolResult }): AfterToolResult | Promise<...>
  /** 一轮结束（finish_reason 三态 / 循环检测 / checkpoint 提交挂这）。 */
  onTurnEnd?(ctx: CoreCtx, ev: { finishReason; toolCalls }): void | Promise<void>
  /** 是否在本轮后停（ask_user / plan 审批的优雅停挂这）。 */
  shouldStop?(ctx: CoreCtx): boolean | Promise<boolean>
}
```

关键：这些槽里**看不到穿进来的状态**——`items`/`run`/`checkpoints`/`meta` 全靠 `ctx.store.getter(...)`。这是和 pi（`transformContext(messages)`）最大的形状差异，也是「状态核心最强」的落地。

---

## 五、九个关注点 → 各归其位

先说清**已经有缝的**，别重复造：

| 关注点 | 现状 | 去向 |
|---|---|---|
| HTTP 重试 | 已在 `api/modelApi.ts` 的 `withRetry` | **不动**（ai 层，已就位） |
| schema 校验 | 已在 `tools/registry.ts` 的 `run()` | 保留在 registry；也可暴露成 `beforeToolCall` 供插件叠加 |
| subagent 分发 | 已经过 `delegate_agent` 工具 + `ToolContext.delegateAgents` | 收拢成 `subagentsPlugin`（工具 + 进程内树 + 树 renderer） |

**还焊在 loop 里、要搬出来的：**

| 关注点 | 现在（modelRun.ts 内联） | 搬到 |
|---|---|---|
| 上下文压缩 | 组 requestBase 前调 `compactContext` | `compactionPlugin` → `transformContext` |
| 模型名迁移 | ghost guard 后 `migrateSessionMeta` | `migrationPlugin` → `prepareRequest` |
| finish_reason 三态 | 收尾分流 + FINISH_REASON_ITEM_NOTICES | `finishReasonPlugin` → `onTurnEnd` |
| 循环检测 | repeatedToolSignatures | `loopGuardPlugin` → `afterToolCall`/`onTurnEnd` |
| 危险工具确认 | pendingToolConfirmation | `confirmPlugin` → `beforeToolCall`（返回 block + 置 pending） |
| ask_user 暂停 | waiting_user + pendingQuestion | `askUserPlugin` → 工具 + `shouldStop` |
| checkpoint 提交/落盘 | commitCheckpoint + persist | 保留为 core loop 收尾职责（不是插件——它是状态核心的一部分） |

搬完后 `runToolLoop` 只剩：发请求 → 执行工具 → 回填 → 循环，加 hook 调用点。九进一出，耦合散尽。

---

## 六、观察 vs 拦截（为什么不另造事件总线）

- **观察型**（渲树面板、埋点、UI 联动）：`api.subscribe(itemsAtom, fn)` / `subscribe(runAtom, fn)`。einfach atom 已可订阅，**订阅即事件流**。
- **拦截型**（能 block/改写：确认门、schema、压缩）：`api.hook('beforeToolCall', fn)`。订阅做不到同步 block，必须显式 hook 槽。

对 RPC/非 React 消费方：core 额外吐一条**规范化事件投影**（从 `runAtom` + trace 派生，`AgentEvent` 联合），走 `server` 包。React 侧继续直读 atom——**加法**，不替换。

---

## 七、裸 setter 下三道守卫怎么活

| 守卫 | 裸 setter 后 | 落地 |
|---|---|---|
| stale-run | 循环内 hook 由 loop 写回守卫覆盖；异步插件自查 | `ctx.isCurrent()` 一行 |
| ghost | 同上（`isCurrent` 含 sessionsAtom 存在性） | 同一次调用覆盖 |
| 不可变 | wrapper 本来也拦不住 | atom 值标 `readonly` + dev freeze |

core 运行时自身仍走 `sessionWriters`/`checkpointWriters`（封装不可变套路）；插件走 `store.setter` 直达。**同一 atom 两个写入方**（core + 插件）是有意的平权——文档标注哪些 atom 是「loop-owned」（插件 mid-turn 写要谨慎）vs「free」。

---

## 八、迁移顺序（先立缝，后拆包）

0. **立缝**：在 `runtime/` 加 `CoreCtx`/`PluginApi`/`LoopHooks`/`runAgentLoop` 骨架 + 插件注册装配。`modelRun` 暂时把自己的内联逻辑注册成「内置插件」跑通——行为零变化，纯搬形状。
1. **验证缝**：把**压缩**抽成 `compactionPlugin`（它已是纯函数，最安全）。`modelRun` 不再直调 `compactContext`，改由插件的 `transformContext` 生效。全测试绿 = 缝的形状对了。
2. **逐个搬**：迁移 → finish_reason → 循环检测 → 确认门 → ask_user。每个一 PR、带回归测试 + 变异自检，绿了再下一个。
3. **subagents/planning/eval 收拢成插件**（保留实现，改挂载）。
4. **实例化**：`createCore(config)` 返回隔离实例，store 随实例发；干掉 `rootStore`/`toolRegistry`/`abortRegistry`/store 缓存的模块单例。**顺带解锁测试 `fileParallelism`**。
5. **物理拆包**：填 `pnpm-workspace.yaml` 的 `packages:`，切 `*-ai` / `*-core` / `*-plugin-*` / `web`。
6. **事件投影 + `server`**：给非 React 消费方补 RPC。

每步都可独立上线、可回滚。拆包在最后，风险最低。

---

## 九、契约 ID 索引

- **PX1 CoreCtx**：运行时句柄，状态从 `ctx.store`/`ctx.root` 取，不穿参。
- **PX2 PluginApi**：装配期注册面，`(api) => void`。
- **PX3 LoopHooks**：薄 loop 的单槽 hook；插件层 fan-out 成多订阅。
- **PX4 裸 setter**：插件平权直写；`isCurrent()` 自查、`readonly` 保不可变。
- **PX5 观察=订阅 atom / 拦截=hook 槽**：不另造事件总线。
- **PX6 ToolContext 保持窄**：工具不拿 store。
- **PX7 先立缝后拆包**：0→6 顺序，拆包最后。
