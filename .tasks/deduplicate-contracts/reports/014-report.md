APPROVED

# 014 行为与兼容性独立复审

## 结论

独立复审 `55a3d2e..2eee1e1` 后，未发现会导致数据丢失、安全边界放宽或正常既有流程回归的 Critical / Important 问题。版本化归档恢复、history cursor/query、当前轮判定、计划持久化、委派能力、workspace mutation、CLI 配置、provider transport 及 013 的机械协议收敛均保持了原有成功/失败语义，新增边界整体向 fail-closed 收紧。

保留三个非阻断 Minor：一处是公开 TypeScript 输入类型的刻意收窄会影响以宽泛 `string[]` 组装参数的源码调用方；一处是归档 CLI 与既有 producer 对 `.` / `..` 这两个非常规 ID 的路径映射仍不一致；一处是基线遗留、零消费方的同名 current-turn helper。三者均未影响当前正常生产路径，也未形成安全退化。

本 reviewer 只修改本报告，未修改产品代码、未暂存、未提交。

## 审查范围与方法

- 阅读任务卡、既有报告及 `git diff 55a3d2e..2eee1e1` 的完整文件清单和产品差异；既有报告仅作证据索引，结论均回到当前源码、基线源码和测试独立核对。
- 对共享实现逐项与 `55a3d2e` 的原本地实现比较，包括条件顺序、默认值、错误类型/文案、持久化时序、legacy 降级及信任边界。
- 重点复核 archive producer/replay、history、current turn、plan、delegation、workspace mutation、CLI；同时覆盖 provider transport、recovery facade、shell 与 013 七个 protocol primitives 的交叉行为。

## Findings

### Critical

无。

### Important

无。

### Minor

#### M-1 — `confirmedTools` 的公开 TypeScript 参数发生源码级收窄

- 基线 `packages/agent-core/src/subagents/types.ts:93,105@55a3d2e` 的 child/root `confirmedTools` 均为 `string[]`；当前 `packages/agent-core/src/subagents/types.ts:74-108` 收窄为 `DelegatableDangerousTool[]`，并由 `packages/agent-core/src/subagents/index.ts:56-73` 公开导出相关输入类型。
- 因此既有调用方若写成 `const tools: string[] = ['write_file']` 再赋给 `DelegateAgentInput`，即使值在运行时合法，也会从“可编译”变为“需先收窄或使用 `as const`”。这是 TypeScript source compatibility 变化。
- 不判为阻断：运行时在基线已经只接受危险工具名；当前 `packages/agent-core/src/subagents/input.ts:94-102,204-225` 仍以同一闭集校验，`packages/agent-core/src/runtime/dangerousTools.ts:35-48,72-75` 明确排除 MCP 并从 root dangerous 集合约束子集。该变化没有撤销任何运行时能力，只让静态类型贴合既有运行时事实；仓内消费者与构建已适配。
- 若未来将 `@einfach-agent/core/subagents` 作为稳定的外部 source-compatible API 发布，应在 release note 标注，或提供一个把 `readonly string[]` 受控收窄为该 union 的入口。

#### M-2 — 归档 CLI 与 producer 对 `.` / `..` 的非常规 ID 映射不一致

- 新 CLI owner 在 `scripts/subagent-archive-paths.js:3-21` 把空值、`.`、`..` 都映为 `unknown` 并验证 containment；replay 与 retention 已共同消费它（`scripts/subagent-replay-report.js:115-120,145-152`、`scripts/subagent-archive-retention.js:121-132`）。
- 既有 producer 仍用 `packages/subagents/src/archive/skillCache.ts:6-12,47-52` 的独立 `safeSegment`；它只对空串回退，`.` / `..` 会原样进入拼接路径。于是使用这两个 ID 产生的非常规/手工归档，旧 CLI 可按旧映射定位，当前 CLI 会查找 `unknown` 路径。
- 不判为 Important：应用正常 session/run ID 由 `newId()` 产生，不会是这两个值；新 CLI 对路径逃逸/折叠是安全收紧，且 ASCII、Unicode、控制字符及正常 `._-` ID 的映射均与 producer 一致。`scripts/subagent-archive-paths.test.js:11-35` 和 retention/replay 进程级测试固定了新安全行为。
- 后续若要支持外部注入 session/run ID，建议让 producer 与 CLI 消费同一可表达的路径段契约，或在 producer 边界直接拒绝 `.` / `..`，避免不可发现的异常归档。

#### M-3 — 基线遗留的同名 current-turn helper 是潜在误导入口

- canonical `packages/agent-core/src/runtime/activeTurnItems.ts:11-24` 接受 `turnId`，缺锚点且没有 user 时返回 0；`packages/agent-core/src/runtime/commands/turnSafety.ts:6-11` 另有同名函数，不接受 `turnId` 且没有 user 时返回 -1。
- `rg` 实查后者除定义外零消费方；生产 recovery 与 tool outcome 消费方都显式导入前者。该文件自 `55a3d2e` 未改变，因此不是本次交付引入的行为回归。
- 不判为 Important：当前没有执行路径能命中旧 helper。它仍是未来误导入后改变 slice 语义的潜在漂移点，建议后续删除未使用导出或改成复用 canonical owner。

## 目标行为域逐项结论

### 1. Archive producer / replay：除 M-2 外无发现

- producer 通过 `packages/agent-core/src/subagents/archiveEventPayload.ts:92-115` 写入固定 v1，并防御性复制 `confirmedTools`、skill IDs、skill files 与 `changeSets`；terminal payload 的 `status/objective/summary/changeSets` 是必填协议。
- v1 decoder 在 `archiveEventPayload.ts:117-170,178-185,227-234` 校验版本、状态、数组及 change set 结构。未知版本或损坏 v1 在 `packages/subagents/src/archive/replay.ts:84-103` 记入 `parseErrors` 并在创建/改变 node 前跳过，不会把未知失败伪造成 `done`。
- terminal result 在 `replay.ts:155-177` 完整恢复 status、objective、summary、resultFile、skills、changeSets、tier/route/fallback/error；objective 优先级是 finished > 显式 snapshot > started，`replay.ts:68-70,134-158` 与 `packages/subagents/src/archive/replayChildPayload.test.ts:13-62` 有直接证据。
- legacy 无版本 payload 仍由 `supportedVersion` 接受，并按可识别字段宽容恢复；这是向后兼容路径。宽容只适用于无版本旧数据，带版本的未知/损坏输入不降级。
- retention 默认只读、mutation 强制 `--write`，且 prune 先导出再删派生物；`scripts/subagent-archive-retention.test.js:59-102` 证明 events 不被 prune/restore 覆盖，失败前后均保留权威事件流。

### 2. History target / cursor / query / recovery facade：无发现

- canonical target decoder 在 `packages/agent-core/src/history/agentHistoryTarget.ts:20-64` 拒绝非 plain object、缺/多字段和空字符串；identity/key 在 `agentHistoryTarget.ts:66-90` 用定长 JSON tuple，避免旧字符串拼接碰撞。
- legacy service cursor 在 `packages/host-node/src/history/historyServiceCursor.ts:13-38` 对 target 与 roles 重新 canonicalize 后比较，因此升级前 target 属性顺序不同的 v1 cursor 仍可用；非 canonical base64url、超长、负 offset、kind/filter 变化均受控失败。
- rollout query cursor 在 `packages/host-node/src/rollout/queryCursor.ts:45-58,65-109` 重做枚举/target 归一化并区分 invalid 与 stale；SQL target predicate 在 `historyTargetSql.ts:30-46` 正确处理 root 的 NULL 字段与参数序号。
- search cursor 的 raw filter 属性顺序比较（`searchCursor.ts:62-72`）自基线已存在，正常 encoder 始终产生同一顺序；未发现本次引入的 legacy 回归。
- SQLite read facade 在 `packages/persistence-sqlite/src/sqliteRecoveryDriver.ts:42-64,75-87` 先校验每个 row 的全部列，再识别 tombstone，并用 row 自身 session ID 校验快照；坏 JSON、generation mismatch、坏 tombstone 均 fail loud，不会静默隐藏损坏历史。

### 3. Current turn / recovery reconciliation：除 M-3 外无发现

- 唯一当前轮边界 `packages/agent-core/src/runtime/activeTurnItems.ts:11-34` 保持原优先级：存在 `turnId` 就精确锚定；缺失/损坏锚点退到最后一条 user；没有 user 从 0 开始。
- `unresolvedToolCalls` 在 `packages/agent-core/src/runtime/toolCallOutcomeFacts.ts:30-54` 只扫描该切片；恢复判据在 `recoveryCommands.ts:138-186` 同样消费共享边界，同时保留 timed receipt 的全 transcript 扫描，避免 session-start/timed 收据被误判为孤儿。
- 缺失 turnId 与旧 checkpoint 的 fallback 行为由 `activeTurnItems.test.ts:13-30`、`toolCallOutcomeFacts.test.ts:22-51` 固定；没有把旧轮危险调用带入当前轮，也没有漏掉无 user 的异常 transcript。

### 4. Plan persistence / failure rollback：无发现

- adapter 在 `packages/agent-core/src/runtime/planPersistence.ts:48-76` 先更新 plan，再等待 recovery persistence；throw 或任何非 `saved` outcome 都在 `planPersistence.ts:22-45,54-63` 将同一 run（或 fallback run）置为 `interrupted`、留下明确错误和 observability event，再向调用方失败。
- session 已消失会在写 plan 前失败（`planPersistence.ts:68-72`）；测试 `planPersistence.test.ts:59-115` 覆盖 throw、error/tombstoned/skipped、session 消失与 fallback run。
- checkpoint rollback 复用首次 adapter 并在裁剪 UI/transient 状态前等待 `plan.stage_rollback` 落盘（`packages/agent-core/src/runtime/commands/planCommands.ts:65-107`）；失败返回 false 且恢复 stopped run 为 interrupted。命令测试 `planCommands.planRuntime.test.ts:161-221` 覆盖等待、拒绝、factory 次数、reason 与 stopped run。
- “失败后内存里已有新 plan”是基线屏障语义：run 已中断，后续执行被阻止；没有谎报成功，也没有自动撤销外部副作用。审批恢复启动异常同样收敛为 interrupted，而非继续执行。

### 5. Delegation capability：除 M-1 外无发现

- root dangerous 全集与 child 可委派子集分别定义，`packages/agent-core/src/runtime/dangerousTools.ts:17-48,50-75` 保证 MCP 只能留在父级；parser 在 `subagents/input.ts:94-102,197-225` 对 root/child confirmedTools 都做闭集校验与去重。
- capability 在 `packages/agent-core/src/subagents/delegationPolicy.ts:91-111` 同时绑定 session、run、delegation call、parent path，并要求后代只能取交集；未知 parent/profile 和任何 widening 都 fail closed。
- host 只从“本次原始 delegate 参数 ∩ 可委派工具 ∩ session 永久放行”签出 capability（`runtime/toolContext/delegationCapabilities.ts:65-84`）；实际 child 调用仍在 98-115 行复查 profile/签名、registration version 与 stale guard，pause 不允许跨 child 边界。
- legacy omission 继续得到 `delegate_only` 和空危险能力；`subagents/input.test.ts:12-33,144-152,187-218` 覆盖缺省与未知/MCP 拒绝。未发现能力扩大或省略值变成隐式授权。

### 6. Workspace mutation：无发现

- `packages/host-node/src/workspace/change/decodeWorkspaceChangeContext.ts:7-35` 保持 null/undefined = 未提供、非对象拒绝、四个 camelCase 字符串必填、命令名进入错误文案；snake_case 内层字段仍拒绝，测试见 `decodeWorkspaceChangeContext.test.ts:21-59`。
- `contentHash.ts:3-15` 保持 UTF-8 SHA-256 与严格小写 `sha256:<64 hex>`；write/patch guard 分别在 `workspace/write/guard.ts:37-66`、`workspace/patch/guard.ts:24-44` 保持“两种证明互斥 → old content → hash 格式 → hash 值”的原顺序，守卫失败不进入落盘。
- 共享 `pathExists` 在 `workspace/common/pathExists.ts:5-12` 继续跟随 symlink，并把 dangling link/任意 stat 错误视为不存在；这与各原副本相同，symlink 自身存在性仍由独立 `lstat` 判据负责。
- 进程级 handler 回归覆盖 write/patch/delete/copy/move；未发现 change journal、乐观并发、symlink confinement 或回执错误码改变。

### 7. CLI model config：无发现

- `apps/cli/src/credentials.ts:65-85,108-139` 统一使用 host 的 key/section/base URL codec；环境变量仍优先，DeepSeek 环境变量仍是“不读可选文件”的完整快速路径，配置键仍为 `deepseek:default`、`glm:default`、`kimi:cn`、`openai-compat:default`。
- 配置文件 ENOENT 仍视为空；坏 JSON/非对象以及含任意非字符串成员的完整 `modelCredentials` 段 fail loud（`credentials.ts:92-105`），避免损坏配置被部分读取或后续静默覆盖。
- API key trim/空值/1024 UTF-8 字节上限由 `packages/host-node/src/model/credentialSection.ts:21-31,44-67` 唯一决定；错误只含配置路径与结构错误，不含 key 值。
- openai-compatible endpoint 在 `openAiCompatBaseUrl.ts:83-102` 只接受 HTTPS 或 HTTP loopback，拒绝 userinfo/query/fragment 并规范化尾斜杠；未知或不安全端点被省略而不会进入 transport。CLI 测试 `credentials.test.ts:6-163` 覆盖优先级、legacy 配置、坏段和安全 URL。

### 8. Provider transport、shell 与 013 primitives：无发现

- provider route policy 在 `packages/agent-ai/src/providerTransport.ts:7-24,34-73,114-218` 固定请求/响应限额、文件元数据、官方 origin 与闭集 method/path；web/host/relay 只投影该表。OpenAI-compatible origin 仍必须由 host 已登记配置解析，调用方不能传 origin/key/header；未知目标 fail closed。
- DeepSeek delete ID 现在与 upload/message reference 共用更严格 ID codec；web 文件名额外拒绝 C1 控制字符。二者是安全收紧，不影响 adapter 正常生成的 ID/文件名。
- shell factory `tools/shell/src/shellCommandTool.ts:1-130` 与三个基线副本逐句相同：trim/default/clamp/env、file-write 拒绝、platform、timeout/nonzero mapping、缺 runShell 错误均不变；三平台表驱动测试覆盖这些分支。
- server bounded reader 在 `apps/server/src/boundedJsonBody.ts:13-64` 按真实字节计数，超限停止累积但继续排空，空 body 由 invoke/model wrapper 保留各自旧语义；stream error 仍 reject。
- IndexedDB transaction 只在 `oncomplete` resolve，请求/同步错误 abort 后保留原始错误（`packages/persistence-idb/src/indexedDbTransaction.ts:14-42`）；observability DB 的 unavailable/error/blocked 语义未变（`packages/observability-idb/src/indexedDbLogDatabase.ts:8-32`）。
- FS workspace envelope 在 `tools/fs/src/workspaceResultEnvelope.ts:7-32` 继续兼容 legacy direct result 与新 `{ok,data/error}`，失败保留工具域 code；ToolResult serializer 在 `packages/agent-core/src/tools/toolResultModelPayload.ts:5-19` 保留 null/falsy 诊断与 warnings，异常 child pause 现在明确降为错误而非空对象。
- ModelSettings schema 在 `packages/agent-core/src/state/modelSettingsSchema.ts:40-76` 与旧 recovery 校验字段/类型一致；未知顶层字段仍由 `settingsBagMigration.ts:24-39` 搬进 `vendorSettings` 后再持久化，旧供应商特化设置不会丢失。

## 补充重复/SRP 线索的行为判定

- **Continuation / archive 枚举：当前无行为风险。** `SubagentContinuationState` 的静态 union 与 recovery codec 的运行时 `childStates`（`packages/agent-core/src/state/recoverySnapshot.type.ts:44-50`、`recoverySnapshot.codec.ts:12-18,244`）当前逐项一致；类型擦除后 codec 必须保有运行时集合。archive event 的 union 与运行时 `Record<SubagentArchiveEventType, true>`（`packages/agent-core/src/subagents/types.ts:30-53`、`packages/subagents/src/archive/replayEventSchema.ts:7-32`）由 TypeScript 缺键/多键检查约束，JS replay 副本另有锁步测试。它们有维护面，但没有当前枚举分叉、legacy 拒绝或能力放宽。
- **`invokeRouteBody.ts`：职责争议不构成行为回归。** Content-Type 判据与 invoke body 的顶层 object 收窄是同一个 HTTP invoke 输入边界中的两个独立导出；实际有界读流已经下沉到 `boundedJsonBody.ts`。当前 `invokeRouteBody.ts:32-67` 保留旧的 empty/object/not-object/stream-error 语义，没有新增解析旁路或 CSRF 放宽。
- **Workspace hash 多实现：当前输出一致，边界不能合并成单一函数签名。** read 域的 `workspace/read/content.ts:31-34` 对原始 `Uint8Array` 哈希，mutation guard 的 `workspace/change/contentHash.ts:3-15` 对已解码文本按 UTF-8 哈希；对可由 read_file 返回并进入乐观守卫的合法 UTF-8 文件，两者逐字相等，已有 `content.test.ts` 和 `contentHash.test.ts` 公共向量。tool 层的 regex 是调用前输入校验，host guard 是不可信命令边界复核，不能删除任一层。未发现当前 hash 格式/编码分叉；未来可共享格式常量，但这不是行为阻断。

## 四类显式判断

| 风险面 | 判断 | 关键证据 |
|---|---|---|
| 未知/损坏输入 | fail closed / fail loud；不会伪造成功或静默隐藏持久化损坏 | v1 archive 跳过并报 parse error；cursor 严格 envelope/base64/filter；SQLite 坏 row/tombstone 抛错；CLI 坏 credential 段抛错；provider 未知 route 拒绝 |
| Legacy 输入 | 正常旧数据可继续读；仅非常规 `.`/`..` archive ID 有 M-2 | 无版本 archive 宽容 decoder；legacy history cursor canonicalize target；缺 turnId 回退最后 user；FS direct result 兼容；旧 settings 顶层特化字段迁入 bag |
| 失败回滚/持久化 | 不谎报成功；在无法证明 durable 时中断 workflow | plan persistence throw/non-saved → interrupted；checkpoint rollback 落盘后才裁剪；IDB transaction complete 后才 resolve；workspace optimistic guard 在 mutation 前失败；retention prune 先导出且需 `--write` |
| 安全边界 | 没有放宽；多处收紧 | provider origin 不来自调用方；delegation capability 四元绑定且排除 MCP；archive CLI containment；workspace symlink/hash guard；不安全 compat URL 与控制字符文件名拒绝 |

## 独立验证

最终干净验证结果：

```text
核心行为批次（archive/history/current-turn/plan/delegation/workspace/CLI/provider/primitives/shell）
Test Files  33 passed (33)
Tests       280 passed (280)

planCommands.planRuntime 隔离复跑
Test Files  1 passed (1)
Tests       6 passed (6)

集成补充批次（archive replay、plan context、delegation profile、recovery settings、
provider wire/relay、IDB consumers、FS consumers、workspace handlers）
Test Files  23 passed (23)
Tests       197 passed (197)

archive CLI 进程级批次
Test Files  3 passed (3)
Tests       16 passed (16)
```

合计 60 个测试文件、499 个断言通过。最初将 plan command 与大批文件并行运行时曾出现一次 Vitest 环境 teardown 后的延迟 plugin import rejection；该文件隔离复跑 6/6 通过，移除它后的其余 33 文件复跑 280/280 且退出码 0，因此未复现为产品行为失败。

`git diff --check 55a3d2e..2eee1e1` 无输出。未重跑全量 build/test；本报告的独立判断不采信既有报告中的全量结果作为替代证据。

## 最终裁决

**APPROVED** — 无 Critical / Important；三个 Minor 限于公开 TypeScript 宽类型调用方式、`.`/`..` 非常规归档 ID 与零消费方基线 helper，正常数据、失败中断、legacy 读取及安全边界均无阻断回归。
