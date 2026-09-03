---
id: 001
title: 归档恢复保留完整子 Agent 结果
kind: leaf
parent: 000
depends_on: []
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-09-03
done: 2026-09-03
base: 55a3d2e
files:
  - packages/agent-core/src/subagents/
  - packages/subagents/src/archive/
---

# 归档恢复保留完整子 Agent 结果

## 目标
让 producer、archive event 与 replay 共享一份版本化事件 payload 契约，使 replay 后的 `ChildAgentResult` 与在线结果等价，尤其保留 `changeSets`、objective 和路由元数据。

## 交付边界
事件 payload 类型/codec、producer 接线、replay 接线和 producer→replay 回归测试必须作为同一个数据完整性修复交付。不得顺手重写 scheduler 或 root/child loop。

## 上下文
- 结果类型：`packages/agent-core/src/subagents/types.ts` 的 `ChildAgentResult`。
- producer：`packages/agent-core/src/subagents/childResult.ts` 与 `childAgentLoop.ts`。
- consumer：`packages/subagents/src/archive/replay.ts`。
- 当前 `child_finished` 未归档 `changeSets`；`child_started` 写出的 objective/路由字段没有完整被 replay 消费。
- 契约放在依赖方向允许 producer 与 replay 同时消费的位置；避免让 agent-core 反向依赖 subagents 包。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- `ChildAgentResult`：完整恢复目标。
### 产出
- 类型化、版本化的 `child_started` / `child_finished` payload codec 或等价纯投影接口，供 producer 与 replay 共用。

## 验收标准
1. `pnpm vitest run packages/agent-core/src/subagents/runtime.requestConstruction.test.ts packages/subagents/src/archive/replay.test.ts packages/subagents/src/archive/replayRouteReason.test.ts` → 全部通过。
2. 新测试证明含 `changeSets` 的在线终态事件经 JSONL replay 后完整恢复，且无 tree snapshot 时能从 `child_started` 恢复 objective 与路由元数据。
3. `pnpm exec tsc -b packages/agent-core/tsconfig.json packages/subagents/tsconfig.json` → 通过。

## 执行记录（仅编排者回写）
- 2026-09-03：派发执行 agent，base `55a3d2e`。
- 2026-09-03：首审 REJECTED；R1 修复未知版本 fail-closed、snapshot 优先级及真实 producer round-trip 覆盖。
- 2026-09-03：R1 独立复审 APPROVED；编排者复跑 30 tests 通过，准予提交。
