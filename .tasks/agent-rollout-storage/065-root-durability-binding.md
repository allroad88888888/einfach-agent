---
id: "065"
title: 绑定 root 强持久化边界
kind: leaf
parent: "3000"
depends_on: ["060"]
discovered_from: null
model: gpt-5.6-sol
status: done
repair_round: 1
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/agent-core/src/runtime/agentRolloutCoordinator.ts
  - packages/agent-core/src/runtime/agentRolloutCoordinator.test.ts
  - packages/agent-core/src/runtime/persistedHistoryLogFlush.ts
  - packages/agent-core/src/runtime/persistedHistoryLogFlush.test.ts
  - packages/agent-core/src/runtime/persistenceBridge.ts
  - packages/agent-core/src/runtime/recoveryWriter.ts
  - packages/agent-core/src/runtime/recoveryWriter.rollout.test.ts
---

# 绑定 root 强持久化边界

## 目标

在 recovery writer 的精确 capture 边界把 root snapshot delta 强写到 rollout，同时保持既有 recovery/undo 行为。

## 上下文

session atom writer 是同步接口，不能直接 await 文件 I/O。`RecoveryWriter` 已经持有一次一致 capture 与异步
durability barrier，是 root 历史的正确接入点。`persistenceBridge.ts` 现有 paired undo-log flush 应抽到
`persistedHistoryLogFlush.ts`，给 rollout dependency 留出清晰职责和行数空间。

## 接口与顺序

- `PersistenceDependencies` 新增可选 `agentRollout?: AgentRolloutDriver`；未配置时现有行为完全不变。
- `AgentRolloutCoordinator.capture(snapshot)` 用 060 delta，成功后才更新内存 previous snapshot。
- 同一次 recovery capture 的顺序：构建 snapshot → rollout append → recovery snapshot save → history-log flush。
- rollout append 失败使该 durability boundary 返回 `RecoveryWriteOutcome {status:'error'}`，不得继续下一次
  模型请求或把 previous 指针前移；沿用 outcome 是为了兼容既有 fire-and-forget recovery 调用并避免 unhandled rejection。
- rollout 已成功而 recovery save 失败时不补偿删除 rollout；它是已经发生的历史证据，下次 dedupe 后重试 recovery。
- hydration 后第一次 capture 对现有 root items 做完整、幂等 backfill。
- session delete/recovery tombstone 不调用 rollout delete；coordinator 的 previous state 只按 session 生命周期清理内存。

## 验收标准

1. root append/update/reorder/delete 在一次 capture 中按 060 输出写入；相同 capture 不重复写。
2. 注入 rollout failure：recovery save 未发生、previous 未前移、调用方收到 `status:'error'`；模型执行 fence 阻断。
3. 注入 recovery failure：rollout 保留；重试不会生成等价重复，recovery 最终成功。
4. 旧 SQLite snapshot hydration 后首次 capture 完整 backfill；第二次为空。
5. session delete 后 rollout mock 未收到 delete；既有 recovery delete 测试仍通过。
6. `pnpm exec vitest run packages/agent-core/src/runtime/agentRolloutCoordinator.test.ts packages/agent-core/src/runtime/recoveryWriter.rollout.test.ts packages/agent-core/src/runtime/persistedHistoryLogFlush.test.ts` → 通过。
7. `pnpm exec tsc -b`、`pnpm check:state` → 通过；改动文件均不超过 300 行。

## 禁止项

- 不移除 recovery snapshot 的 items，不改变 generation/undo 语义。
- 不让 rollout 反向 overlay 到 runtime recovery；那是另一项迁移设计。
