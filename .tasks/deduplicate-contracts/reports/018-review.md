# 018 独立复审：子 Agent 能力值贯穿输入、恢复与归档协议

## 结论

APPROVED。基于任务卡、018 执行报告和 `git diff c804cd4 --` 的任务 files 限定差异，所有验收项均有实现证据，未发现阻断或非阻断质量缺口。

## Findings

### Critical

无。

### Important

无。

### Minor

无。

## 逐项验收

### 1. 公共能力类型与 runtime decoder 单一来源

通过。

- canonical owner 保持明确：model tier、task category、risk level 分别由 `types.ts:11-25` 的 `SUBAGENT_*` readonly tuple 及其派生类型拥有；tool profile 由 `toolProfile.ts:9-17` 拥有；confirmed tool 由 `dangerousTools.ts:36-48,73-75` 的 `DELEGATABLE_DANGEROUS_TOOLS`、派生类型和 predicate 拥有。
- 输入边界已经消费这些 owner：`input.ts:59-85` 从公共集合生成错误文案并收窄 tier/category/risk/profile，`input.ts:94-102` 通过 `isDelegatableDangerousTool` 收窄并去重 confirmed tools。没有新增平行 allowlist。
- continuation 类型不再重写能力 union：`ChildTaskSnapshot` 在 `continuationDescriptor.ts:13-31` 直接引用 `SubagentModelTier`、`SubagentTaskCategory`、`SubagentRiskLevel`、`SubagentToolProfile` 与 `DelegatableDangerousTool`。
- continuation runtime decoder 在 `continuationDescriptorParser.ts:74-120` 直接消费四个公共 readonly 集合和 confirmed-tool predicate；未知值使整个 descriptor 返回 `undefined`，不会形成可恢复任务。
- archive payload、creator input 与 decoded 类型在 `archiveEventPayload.ts:23-104` 对协议已有的 model tier、tool profile、confirmed tools 字段全部引用公共类型；versioned decoder 在 `archiveEventPayload.ts:131-185,227-252` 直接消费公共集合/predicate。
- 对三个 continuation/archive 生产文件的能力字面量静态扫描为空；只保留 version、status、lifecycle 等任务卡明确豁免的非能力枚举。

### 2. input → policy → state → child 链路闭合

通过。

- `resolveDelegationRequestPolicy` 先调用 `normalizeDelegateAgentInput`，其返回的 `DelegateAgentInput` 已持有公共能力类型（`delegationPolicy.ts:43-50`）。
- policy 对宿主 capability 再执行运行时校验：`delegationPolicy.ts:97-120` 仅在全部 `toolNames` 通过 `isDelegatableDangerousTool`、scope/correlation 匹配且不突破祖先 ceiling 时生成 `readonly DelegatableDangerousTool[]`；未知工具不会进入继承能力。
- policy 输出 `requestedToolProfile: SubagentToolProfile` 与 `requestedConfirmedTools: readonly DelegatableDangerousTool[]`（`delegationPolicy.ts:22-30`）。
- state map 已由 `readonly string[]` 收紧为 `Map<string, readonly DelegatableDangerousTool[]>`（`runtimeState.ts:35-43`）。`delegationBatch.ts:122-132` 将每个 normalized child 的 profile/tools 写入该 map，`delegationBatch.ts:183-191` 再从 map 传给 child。
- `RunChildAgentInput.confirmedTools` 已收紧为公共类型（`childAgentLoop.ts:50-64`）；child 用同一数组构造允许工具、路由输入、system prompt 和 started archive payload（`childAgentLoop.ts:80-118,138-150`）。model tier/category/risk 则始终留在已归一化的 `DelegateAgentChildSpec`，由 batch 直接传入 child，并同时传入 queued continuation producer，没有经过宽泛字符串容器。

### 3. continuation / recovery 持久化闭环

通过。

- `copyTask` 与 `taskJson` 在 `continuationDescriptor.ts:155-193` 逐字段复制五类能力，confirmed tools 另建数组，输入不会在持久化过程中退化为 string。
- parser 对 descriptor `version !== 1` 直接拒绝（`continuationDescriptorParser.ts:48-50`）；五类未知能力分别由公共集合/predicate 拒绝（`continuationDescriptorParser.ts:82-104`）。解析失败经 `parseChildContinuation` 统一变为 `requires_reconciliation`，不会恢复为 runnable。
- 新增表驱动用例遍历 `SUBAGENT_MODEL_TIERS`、`SUBAGENT_TASK_CATEGORIES`、`SUBAGENT_RISK_LEVELS`、`SUBAGENT_TOOL_PROFILES`、`DELEGATABLE_DANGEROUS_TOOLS`，逐项执行 descriptor create → JSON → read round-trip（`continuationDescriptor.test.ts:94-109`）。
- 同一测试对五类未知值逐项断言 descriptor 解析失败且恢复 disposition 为 reconciliation（`continuationDescriptor.test.ts:111-131`）；原有 lineage、unknown field、waiting 与 terminal 行为测试仍保留。

### 4. versioned archive fail-closed 与 legacy 兼容

通过。

- `supportedVersion` 只接受缺省版本或当前 v1（`archiveEventPayload.ts:194-200`）；versioned started payload 必须满足 objective 及所有已出现字段的运行时 codec，未知 model tier/tool profile/confirmed tool 返回 `undefined`（`archiveEventPayload.ts:131-146`）。versioned finished payload同样拒绝未知 tier（`archiveEventPayload.ts:159-172`）。
- 无版本 legacy payload 继续走宽松投影：单个未知能力字段只被忽略，不会让旧事件整体无效；有效旧字段仍按既有逐字段方式读取。
- archive 表驱动测试遍历全部公共 model tier（started 与 finished）、tool profile 和 confirmed tool（`archiveEventPayload.test.ts:13-43`）；另覆盖三类未知 versioned 能力、unknown started/finished version、unknown finished tier，以及 started/finished legacy 宽松解码（`archiveEventPayload.test.ts:45-99`）。

### 5. 公共导出与运行时依赖图

通过。

- `subagents/index.ts:65-92` 继续公开三类模型/任务/risk 类型及 canonical values，`index.ts:141-156` 继续公开 tool profile value/type 与 confirmed-tool value/type。
- archive creator、decoder、payload 与 decoded types 继续由 `subagents/index.ts:97-110` 的既有公共面导出；新增 decoded 字段因此也进入同一公开契约，没有要求消费者深链内部文件。
- 新增运行时边只有 `archiveEventPayload` / `continuationDescriptorParser` 指向三个 canonical owner。反向引用均不存在：`types.ts` 对 dangerous tool/tool profile 是 `import type`，`continuationDescriptor.ts` 对能力 owner 也是 `import type`；`dangerousTools.ts` 和 `toolProfile.ts` 不依赖 continuation/archive。限定任务图无运行时循环。

### 6. 文件规模与静态质量

通过。

- 全部任务 files 当前物理行数均 `≤300`。改动/新增文件分别为：`archiveEventPayload.ts` 270、`archiveEventPayload.test.ts` 100、`childAgentLoop.ts` 296、`continuationDescriptor.ts` 205、`continuationDescriptorParser.ts` 220、`continuationDescriptor.test.ts` 228、`delegationPolicy.ts` 139、`runtimeState.ts` 265。
- 任务范围内未改但参与链路的文件也在上限内；最高为 `delegationBatch.ts` 300 行。
- scoped `git diff --check c804cd4 -- <task files>` 无输出。

## 测试证据口径

按 reviewer 指令，本轮没有重跑测试或构建。以下仅记录 018 执行报告提供的证据，不冒充本轮复跑结果：

- 指定验收集：4 files / 73 tests passed。
- 加入 policy/state/child 就近回归：5 files / 81 tests passed。
- `pnpm build` 通过。
- `pnpm exec tsc -b --pretty false` 通过。

代码审阅与表驱动用例内容和上述结果声明一致，未发现会使这些证据失效的遗漏。

## 范围声明

本报告只使用 018 任务卡、018 执行报告及 `c804cd4` 后任务 files 的限定差异/当前内容；未读取或依赖 index，未纳入 017/019 commits 或 020 未提交 diff。除本报告外未修改产品代码或任务文档，未提交。
