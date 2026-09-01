# 070 独立复审与最终端到端审计

VERDICT: FAIL

严重度：Critical 0 / Important 1 / Minor 0。

本轮只按合并后 070 与当前收缩边界审查；global list/search 只走 canonical catalog/FTS，已取消的
global legacy ordered merge、filesystem snapshot pagination 等架构不在 verdict 范围。010 已 PASS，020
最终 R3 已 PASS，060 simplified R3 已 PASS。

## Findings

### Critical

无。

### Important

1. **Web HTTP 链丢失 `AgentHistoryError.code`，四工具无法稳定返回 typed history error。**

   Node history provider 会抛带稳定 `code` 的 `AgentHistoryError`，但 server 通用错误映射的
   `commandFailureCode()` 只识别 MCP kind 与 model reason，其他错误统一变成 `command_failed`
   （`apps/server/src/invokeRouteError.ts:101-108,120-130`）。浏览器 `httpInvoke` 随后又把
   `ServerInvokeError` 折成裸字符串（`apps/web/src/host/serverInvoke.ts:224-231`），070 adapter 对四方法
   直接透传该 invoke rejection（`apps/web/src/persistence/serverAgentHistoryCapability.ts:12-33`）。工具层
   只有 `error instanceof AgentHistoryError` 才保留 code；裸字符串会落到
   `AGENT_HISTORY_QUERY_FAILED`、`retryable:true`（例如
   `tools/agents/src/list-agent-histories/list-agent-histories.ts:24-33,63-66`；其余三项同形）。因此 Web
   上的 invalid/stale cursor、history/item not found、item deleted、source corrupt 都被错误改类，违反
   “typed exception 稳定”端到端合同；其中 source corruption 还从不可重试降成了可重试。

   本人最小实跑把 `new AgentHistoryError('AGENT_HISTORY_INVALID_CURSOR','bad cursor')` 送入生产
   `mapInvokeRouteError()`，结果精确为
   `{"statusCode":502,"error":"command_failed","message":"bad cursor"}`；再送过生产
   `createHttpInvoke()`，rejection 精确为裸字符串 `"bad cursor"`。现有测试没有覆盖这条链：
   `serverAgentHistoryCapability.test.ts` 只用成功 mock，四个 tool test 则直接在同进程抛
   `AgentHistoryError`，两边都绕过 HTTP 序列化。

   可执行修复：最小扩展 070 owner，加入 `apps/server/src/invokeRouteError.ts` 及其测试，让 server 仅对
   闭合的 `AgentHistoryErrorCode` 集合透传 `error`；然后在 070 owner
   `serverAgentHistoryCapability.ts` 使用保留 `ServerInvokeError.code` 的调用面，并只把合法 history code
   重建为 `AgentHistoryError`。补一条从 server error mapper → Web adapter → 实际 tool execute 的定向测试，
   对 `AGENT_HISTORY_INVALID_CURSOR` 与 `AGENT_HISTORY_SOURCE_CORRUPT` 断言 code/retryable。仅修改当前
   070 owner 无法完整修复，因为 code 已在非 owner server mapper 处不可逆丢失；应扩 owner 或新增一个
   合并粒度的 discovered fix leaf，不需要恢复任何已取消 legacy 架构。

### Minor

无。

## 其余合同核对

- ✅ **Core 隔离与绑定。** `PersistenceDependencies` 的 provider 槽、partial configure、dependencies 与
  reset 位于 `persistenceBridge.ts:41-58,82-120`，每个 bridge 闭包独立。provider 缺席时
  `createHistoryCapabilities()` 真正返回空对象（`historyCapabilities.ts:5-14`），ToolContext spread 后没有
  空成功 facade；存在时只把已解析 workspace root 放进隐藏 locator。递归 `callTool` 原样传同一个
  `core`（`toolContext.ts:115-153`），child execution 复用该 context/provider。定向测试覆盖两个独立
  Core、缺席 Core、trim 后 workspace、recursive callTool 与三档 child。
- ✅ **CLI 单一身份与生命周期。** `persistence.ts:40-57` 从同一个 executor、rollout driver 与 recovery
  facade 创建唯一 provider并注入 core；`runtime.ts:102-147` 把同一 rollout/provider 以 borrowed 方式交给
  host。唯一 persistence disposer 仍只执行 recovery → rollout flush（`persistence.ts:71-74`），history
  没有 disposer；真实模型 loop 的顺序测试为 reconcile → root append → model loop → recovery flush →
  rollout flush。前置 rollout 树已经拥有 driver/fence/flush 改动；070 增量只是读 capability identity 接线，
  未创建第二 database 或 history driver。
- ⚠️ **Web 装配除 typed error 外成立。** 四命令的 input envelope 与隐藏 `legacyWorkspaceRoot` 在
  `serverAgentHistoryCapability.ts:16-33` 原样透传，成功 result 的 warnings/cursor/nextOffset 不改形；
  server bundle 才创建 rollout/history adapter，static bundle返回对象没有这两个键
  （`persistenceDrivers.ts:30-44,73-84`）。前置 rollout 的 source-reconcile fence 仍在 hydrate/newSession/
  render 之前，source warning 的独立入口测试通过；typed query failure 的缺口见 Important 1。
- ✅ **工具 schema、结果与注册。** 四项顶层与 target 两分支均 `additionalProperties:false`，root/child
  required 字段、status/role 枚举、limit/cursor/offset/query 上限齐全；成功分支直接把 provider structured
  result 放进 `data`，不会丢 warnings、cursor 或 nextOffset，缺 capability 返回稳定 unavailable。agents
  registry 每项恰注册一次（`tools/agents/src/index.ts:24-37`），standard 聚合总数/注释/测试均为 36，重复
  注册仍为 36；四项无 replayUnsafe 标记。typed error 的 Web 传输例外见 finding。
- ✅ **Child manifest 与真实 gate。** `historyToolProfile.ts:4-17` 只开放精确四个 history 名称，三个合法
  profile 均允许而未知 profile fail closed；`toolProfile.ts:34-59` 的三档 manifest 含四项，默认分支只留
  delegate。真实 execution gate 在 `delegationCapabilities.ts:91-104` 同时检查 history 名称与合法 profile，
  没有新增 permission、approval、ancestor 或 confirmed-tool 条件，非 history 工具不被提升。prompt 的三档
  文案与这些能力一致。
- ✅ **文档与收缩实现一致。** `docs/agent-history-tools.md:1-34` 明确本机可见性、canonical JSONL、SQLite
  read model、FTS derived index、global canonical-only、targeted legacy fallback、static unavailable 与预算/
  错误边界；`docs/agent-rollout-storage.md:46-48` 只链接查询层，没有恢复已取消范围。文档所称 stable typed
  errors 在 Web 当前尚未兑现，正是本轮 finding，而不是文档要求错误。
- ✅ **Owner/SRP。** 41 个 owner 全部 `<=300`；最大 `persistenceBridge.ts` 254 行、`main.tsx` 240 行。
  新增 binder、CLI provider factory、Web adapter、四个 tool、history profile 各只有一个职责；未发现假拆分。

## 亲自验证

- Focused Vitest：17 files / 64 tests passed。
- `pnpm exec tsc -b --pretty false`：passed。
- `pnpm --filter @einfach-agent/tools-agents build`、`pnpm --filter @einfach-agent/host-node build`：passed。
- `pnpm exec vite build --config vite.config.ts`：passed，仅既有 dynamic-import/chunk-size warnings。
- `pnpm check:boundaries`、`pnpm check:state`、`git diff --check`：passed。
- `pnpm --filter @einfach-agent/core build`：tsup passed，随后仍失败于非 070 owner
  `packages/agent-core/src/state/persistence/modelMigration.ts:25` 的 `DeepSeekReasoningEffort` 不兼容；该文件与
  `packages/agent-ai/src/deepseek.ts` 相对共同基线均无 diff，010 最终 review 已记录同一错误，确认不是
  070 增量。
- `pnpm --filter @einfach-agent/tools build`：tsup passed，declaration 失败于既有
  `@einfach-agent/tools-vision` 无法解析。`tools/standard/package.json` 及该 import 相对共同基线未改，本地
  `tools/standard/node_modules/@einfach-agent` 精确缺少 tools-vision symlink，而其他七个 workspace link
  存在；确认是未刷新安装状态，不是 070 的四工具注册或产品依赖错误。
- 受控错误链复现：server mapper 把 typed history error 映为 `command_failed`，Web `httpInvoke` 再抛裸
  字符串；该结果构成本轮唯一 Important。

## R2 最终复审

VERDICT: PASS

严重度：Critical 0 / Important 0 / Minor 0。

本轮只复查上一轮唯一 Important 与紧邻传输回归；已取消的 global legacy ordered merge、filesystem
snapshot pagination 等范围仍不参与 verdict。

### 原 finding 关闭

- ✅ **闭合 history error code 已跨 server mapper 保留。** `historyQuery.ts:30-45` 以唯一
  `AGENT_HISTORY_ERROR_CODES` tuple 同时推导类型并提供 runtime predicate；server mapper 只在
  `error.code` 命中该 predicate 时透传（`apps/server/src/invokeRouteError.ts:103-116`），其它值仍落
  `command_failed`。本人把 tuple 中全部 7 个合法 code 逐一送入生产 `mapInvokeRouteError()`，7 项输出
  均与输入 code 精确相等；相似未知值 `AGENT_HISTORY_SOURCE_CORRUPTED` 精确输出 `command_failed`。
- ✅ **Web 生产默认只重建合法 `AgentHistoryError`。** adapter 默认调用保留
  `ServerInvokeError.status/code/message` 的 `invokeServerCommand`，而不是通用裸字符串 facade
  （`serverAgentHistoryCapability.ts:10-24,33-54`）；catch 同时要求 `instanceof ServerInvokeError` 与闭合
  predicate 命中才重建 `AgentHistoryError`，网络失败、未知 code 与普通错误原样继续抛。成功 envelope
  与隐藏 workspace locator 仍不改形（测试 `serverAgentHistoryCapability.test.ts:70-85`）。
- ✅ **mapper → Web adapter → 实际 tool 的分类闭环。** 生产 mapper 生成失败信封、真实结构化 Web
  transport、默认 adapter 和真实 `list_agent_histories.execute` 的测试在
  `serverAgentHistoryCapability.test.ts:87-109` 覆盖：`AGENT_HISTORY_INVALID_CURSOR` 与
  `AGENT_HISTORY_SOURCE_CORRUPT` 都保留 code 且 `retryable:false`；未知 history-like code 返回
  `AGENT_HISTORY_QUERY_FAILED` 且 `retryable:true`。注入 seam 的合法 code 重建另由 `:112-121` 覆盖。

### 相关回归抽查

- ✅ server mapper 的 dispatch 404/501 优先级、MCP 开放 kind 与永久/暂时 verdict、model 闭合 reason、
  无标识命令的 `command_failed` 均保持；history code 没有抢占真实 MCP/model/dispatch 错误形状。
- ✅ 通用 `httpInvoke` 未改，仍在 `apps/web/src/host/serverInvoke.ts:224-231` 把
  `ServerInvokeError` 折成 Tauri-compatible 裸字符串；它的成功、401、网络失败及两种 core catch 形状
  回归测试通过。只有 history adapter 选择结构化调用面。
- ✅ R2 扩展后的 43 个 070 owner 全部 `<=300`；最大仍为 `persistenceBridge.ts` 254 行。新增的 core
  predicate、server mapper 扩展和 Web history adapter 各自仍聚焦单一合同/适配职责。

### 亲自验证

- 紧邻定向 Vitest：6 files / 59 tests passed，包含 core history contract、server mapper、真实 invoke
  failure、通用 Web transport、Web history adapter 与实际 tool。
- `pnpm exec tsc -b --pretty false`：passed。
- `pnpm --filter @einfach-agent/tools-agents build`、`pnpm --filter @einfach-agent/server build`：passed。
- `pnpm exec vite build --config vite.config.ts`：passed，仅既有 dynamic-import/chunk-size warnings。
- `pnpm check:boundaries`、`pnpm check:state`、`git diff --check`：passed。
