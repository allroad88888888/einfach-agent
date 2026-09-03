---
id: 006
title: 所有恢复判据使用同一当前轮边界
kind: leaf
parent: 000
depends_on: []
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-09-03
done: 2026-09-03
base: 17113d9
files:
  - packages/agent-core/src/runtime/activeTurnItems.ts
  - packages/agent-core/src/runtime/activeTurnItems.test.ts
  - packages/agent-core/src/runtime/toolCallOutcomeFacts.ts
  - packages/agent-core/src/runtime/toolCallOutcomeFacts.test.ts
  - packages/agent-core/src/runtime/commands/recoveryCommands.ts
  - packages/agent-core/src/runtime/commands/recoveryCommands.continue.test.ts
---

# 所有恢复判据使用同一当前轮边界

## 目标
模型 bootstrap、未配对工具调用识别和恢复准入使用同一个纯函数计算当前用户轮起点。

## 交付边界
边界函数、三个 consumer 接线以及锚点命中/丢失/无 user 的契约测试作为一个工具恢复安全修复交付。

## 上下文
- 三份等价算法位于 `activeTurnItems.ts`、`toolCallOutcomeFacts.ts`、`commands/recoveryCommands.ts`。
- 正式规则：优先查找 `turnId` 对应 entry；不存在时取最后一条 user；均无则从 0 开始。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- 带 `id` 和 `item.role` 的只读 item 序列及可选 `turnId`。
### 产出
- `currentTurnStartIndex(items, turnId): number`，并由 `currentTurnItems` 复用。

## 验收标准
1. `pnpm vitest run packages/agent-core/src/runtime/activeTurnItems.test.ts packages/agent-core/src/runtime/toolCallOutcomeFacts.test.ts packages/agent-core/src/runtime/commands/recoveryCommands.continue.test.ts` → 全部通过。
2. `rg "function (turnStart|currentRunStart)" packages/agent-core/src/runtime` → 无私有副本。
3. `pnpm exec tsc -b packages/agent-core/tsconfig.json` → 通过。

## 执行记录（仅编排者回写）
- 2026-09-03：派发执行 agent，base `17113d9`。
- 2026-09-03：执行 DONE_WITH_CONCERNS，仅范围外 md?raw 类型构建失败；独立 reviewer APPROVED。
- 2026-09-03：编排者复跑 17 tests 通过，准予提交。
