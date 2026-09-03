# 018 执行报告：子 Agent 能力值贯穿输入、恢复与归档协议

## 状态

DONE

## 交付结果

- `ChildTaskSnapshot` 的 model tier、task category、risk level、tool profile 与 confirmed tools 全部改为引用既有公共类型。
- continuation v1 parser 改为消费 `SUBAGENT_MODEL_TIERS`、`SUBAGENT_TASK_CATEGORIES`、`SUBAGENT_RISK_LEVELS`、`SUBAGENT_TOOL_PROFILES` 与 `isDelegatableDangerousTool`，删除能力值的手写集合。
- child archive started/finished payload、creator input 与 decoded 类型改为引用 `SubagentModelTier`、`SubagentToolProfile` 与 `DelegatableDangerousTool`。
- versioned child-started archive decoder 现在从公共集合/predicate 校验 tool profile 与 confirmed tools，并在解码结果中保留它们；未知能力值继续 fail closed。
- `DelegationRequestPolicy`、`DelegationCallState.confirmedToolsByPath` 与 `RunChildAgentInput` 的 confirmed-tools 必经链路统一为 `readonly DelegatableDangerousTool[]`。policy 仍在宿主 capability 信任边界执行运行时 predicate 校验。
- legacy archive 解码保持宽松：未知能力字段被忽略，不会把旧 payload 判成无效；未知 payload version 仍被拒绝。

## 修改文件

- `packages/agent-core/src/subagents/continuationDescriptor.ts`
- `packages/agent-core/src/subagents/continuationDescriptorParser.ts`
- `packages/agent-core/src/subagents/continuationDescriptor.test.ts`
- `packages/agent-core/src/subagents/archiveEventPayload.ts`
- `packages/agent-core/src/subagents/archiveEventPayload.test.ts`（新增）
- `packages/agent-core/src/subagents/delegationPolicy.ts`
- `packages/agent-core/src/subagents/runtimeState.ts`
- `packages/agent-core/src/subagents/childAgentLoop.ts`

任务卡列出的 `dangerousTools.ts`、`types.ts`、`toolProfile.ts`、`input.ts`、`index.ts` 与后续扩入的 `delegationBatch.ts` 无需修改：它们已经分别提供 canonical owner、输入归一化、公开导出或通过类型推断消费收窄后的 policy 结果。

## 测试证据

1. 指定验收命令：

   `pnpm exec vitest run packages/agent-core/src/subagents/continuationDescriptor.test.ts packages/agent-core/src/subagents/archiveEventPayload.test.ts packages/agent-core/src/subagents/input.test.ts tools/agents/src/delegate-agent/delegate-agent.test.ts`

   结果：4 files passed，73 tests passed。

2. confirmed-tools policy/state/child 就近回归：

   `pnpm exec vitest run packages/agent-core/src/subagents/continuationDescriptor.test.ts packages/agent-core/src/subagents/archiveEventPayload.test.ts packages/agent-core/src/subagents/input.test.ts packages/agent-core/src/subagents/runtime.capabilityAndProfile.test.ts tools/agents/src/delegate-agent/delegate-agent.test.ts`

   结果：5 files passed，81 tests passed。

3. 完整构建：

   `pnpm build`

   结果：通过。TypeScript project build、Vite Web build 与 server tsup build 全部完成；仅输出既有的 Vite dynamic/static import 与 chunk-size 警告。

4. 最终类型门禁：

   `pnpm exec tsc -b --pretty false`

   结果：通过。

5. 静态扫描与 diff：

   - continuation/archive 三个生产文件已扫描确认不再出现五类能力值的手写字面量集合。
   - scoped `git diff --check` 通过。

## 表驱动覆盖

- continuation round-trip 遍历全部公共 model tiers、task categories、risk levels、tool profiles 与 delegatable dangerous tools。
- archive round-trip 遍历其协议已有字段的全部公共 model tiers、tool profiles 与 delegatable dangerous tools；model tier 同时覆盖 started/finished payload。
- continuation 与 versioned archive 均覆盖未知能力值 fail-closed。
- archive 同时覆盖 unknown version、未知 finished tier，以及 started/finished legacy 宽松解码。

## 文件职责与行数

- `archiveEventPayload.ts`：270 行
- `archiveEventPayload.test.ts`：100 行
- `childAgentLoop.ts`：296 行
- `continuationDescriptor.ts`：205 行
- `continuationDescriptorParser.ts`：220 行
- `continuationDescriptor.test.ts`：228 行
- `delegationPolicy.ts`：139 行
- `runtimeState.ts`：265 行

全部改动文件均不超过 300 行；新增测试文件只负责 child archive payload codec 行为。

## 范围与工作区

- `runtimeState.ts`、`childAgentLoop.ts`、`delegationPolicy.ts`、`delegationBatch.ts` 的 files 扩展均由编排者裁决并回写任务卡后执行。
- 未修改、暂存、还原或提交并行任务的工作区变更；本任务未 stage、未 commit。
- 无遗留阻断或已知 concern。
