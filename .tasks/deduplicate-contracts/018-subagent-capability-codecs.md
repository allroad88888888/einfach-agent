---
id: 018
title: 子 Agent 能力值贯穿输入、恢复与归档协议
kind: leaf
parent: 000
depends_on: [016]
discovered_from: 016
model: gpt-5.6-sol
status: done
created: 2026-09-03
done: 2026-09-03
base: c804cd4
files:
  - packages/agent-core/src/runtime/dangerousTools.ts
  - packages/agent-core/src/subagents/types.ts
  - packages/agent-core/src/subagents/toolProfile.ts
  - packages/agent-core/src/subagents/input.ts
  - packages/agent-core/src/subagents/runtimeState.ts
  - packages/agent-core/src/subagents/childAgentLoop.ts
  - packages/agent-core/src/subagents/delegationPolicy.ts
  - packages/agent-core/src/subagents/delegationBatch.ts
  - packages/agent-core/src/subagents/continuationDescriptor.ts
  - packages/agent-core/src/subagents/continuationDescriptorParser.ts
  - packages/agent-core/src/subagents/continuationDescriptor.test.ts
  - packages/agent-core/src/subagents/archiveEventPayload.ts
  - packages/agent-core/src/subagents/archiveEventPayload.test.ts
  - packages/agent-core/src/subagents/index.ts
---

# 子 Agent 能力值贯穿输入、恢复与归档协议

## 目标
让 model tier、task category、risk level、tool profile 与 confirmed tool 的类型和运行时校验全部消费现有公共集合，新增能力值不再要求续跑 parser 或 archive codec 手工同步字面量。

## 交付边界
输入、recovery continuation 与 archive event 是同一委派协议的三个持久化表面，必须一起闭环。保留既有 v1/legacy fail-closed 行为与公开导出，不合并不同生命周期实现。

## 上下文
canonical 常量已在 `subagents/types.ts`（tiers/categories/risks）、`subagents/toolProfile.ts`（profiles）与 `runtime/dangerousTools.ts`（delegatable tools）。当前 `continuationDescriptor.ts` 重写 union，parser 重写数组；`archiveEventPayload.ts` 重写 tier 且把 tool profile/confirmed tools 退化为 string。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- `SUBAGENT_MODEL_TIERS` / `SubagentModelTier`、`SUBAGENT_TASK_CATEGORIES` / `SubagentTaskCategory`、`SUBAGENT_RISK_LEVELS` / `SubagentRiskLevel`。
- `SUBAGENT_TOOL_PROFILES` / `SubagentToolProfile`。
- `DELEGATABLE_DANGEROUS_TOOLS` / `DelegatableDangerousTool` / `isDelegatableDangerousTool`。
### 产出
- `ChildTaskSnapshot` 与 archive payload/input/decoded 类型引用公共类型；continuation/archive runtime decoder 从公共 readonly 集合或公共 predicate 判断。

## 验收标准
1. 静态扫描 continuation/archive 不再出现上述能力值的完整手写 union/数组；协议版本、status 等非能力枚举不在此限制。
2. 新增表驱动测试遍历所有公共能力值，证明 continuation descriptor 与 versioned archive payload 可 round-trip；未知值继续 fail closed，legacy 行为不退化。
3. `pnpm exec vitest run packages/agent-core/src/subagents/continuationDescriptor.test.ts packages/agent-core/src/subagents/archiveEventPayload.test.ts packages/agent-core/src/subagents/input.test.ts tools/agents/src/delegate-agent/delegate-agent.test.ts` → 全部通过。
4. 所有新增/大改文件 `wc -l` ≤300，`pnpm build` 或等价完整类型门禁通过。

## 执行记录（仅编排者回写）
- 2026-09-03：并行派发实现。
- 裁决: 纳入 `runtimeState.ts` 与 `childAgentLoop.ts` 的 `confirmedTools` 类型接线 — 它们位于规范化输入到 archive producer 的必经链路，继续用 `readonly string[]` 会破坏公共能力类型闭环并导致根 build TS2322 — 若不纳入，018 无法通过类型门禁。
- 裁决: 纳入 `delegationPolicy.ts` 与 `delegationBatch.ts` 的 confirmedTools 类型接线 — policy 是规范化能力的 owner，batch 是写入 state map 的唯一通路，二者继续暴露 `readonly string[]` 会在 build 产生 TS2345 — 若不纳入，类型闭环仍断在生产链路中。
- 2026-09-03：实现与独立审查 APPROVED；执行侧完整 build/tsc 通过，编排者复跑 5 files / 82 tests 通过。
