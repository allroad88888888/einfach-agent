---
id: 017
title: 当前轮边界只保留一个可导入实现
kind: leaf
parent: 000
depends_on: [016]
discovered_from: 016
model: gpt-5.6-terra
status: done
created: 2026-09-03
done: 2026-09-03
base: c804cd4
files:
  - packages/agent-core/src/runtime/activeTurnItems.ts
  - packages/agent-core/src/runtime/activeTurnItems.test.ts
  - packages/agent-core/src/runtime/commands/turnSafety.ts
  - packages/agent-core/src/runtime/commands/turnSafety.test.ts
---

# 当前轮边界只保留一个可导入实现

## 目标
删除或兼容转发旧的同名 current-turn helper，使全仓只有 `runtime/activeTurnItems.ts` 定义 `currentTurnStartIndex(items, turnId)` 的语义。

## 交付边界
这是恢复与工具结果判据的唯一边界契约。`turnSafety.ts` 只负责当前片段是否含副作用；不得保留第二份查找最后 user 的算法，也不得改变现有 side-effect 判定。

## 上下文
`runtime/commands/turnSafety.ts:6-11` 的零消费旧导出忽略 `turnId` 且无 user 时返回 `-1`；canonical owner 位于 `runtime/activeTurnItems.ts:12-25`，生产消费者已全部使用它。016 报告将其判为重复 owner。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- `currentTurnStartIndex(items, turnId): number`：保留 `activeTurnItems.ts` 的现有签名与 fallback。
### 产出
- `turnSafety.ts` 仅导出 `currentTurnHasSideEffects`；无第二份 current-turn start 实现。

## 验收标准
1. `rg -n "function currentTurnStartIndex" packages/agent-core/src/runtime` → 只有 canonical owner 一处。
2. `pnpm exec vitest run packages/agent-core/src/runtime/activeTurnItems.test.ts packages/agent-core/src/runtime/commands/turnSafety.test.ts` → 相关边界与副作用行为通过；不存在的测试路径应按实际现状调整，不为凑文件新建空测试。
3. `pnpm exec tsc -p packages/agent-core/tsconfig.json --noEmit` → 无类型回归；若受仓库已知 raw module 单独构建限制，必须记录并以根 build 最终验证。

## 执行记录（仅编排者回写）
- 2026-09-03：派发实现。
- 2026-09-03：实现 DONE_WITH_CONCERNS，独立审查 APPROVED；构建 concern 来自并行 018 类型施工与已知孤立 tsc raw module 解析，不属于 017 产品回归。
