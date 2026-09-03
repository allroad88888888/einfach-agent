---
id: 007
title: 命令与模型工具共享同一计划持久化屏障
kind: leaf
parent: 000
depends_on: [006]
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-09-03
done: 2026-09-03
base: 7939d09
files:
  - packages/agent-core/src/runtime/planPersistence.ts
  - packages/agent-core/src/runtime/planPersistence.test.ts
  - packages/agent-core/src/runtime/commands/planCommands.ts
  - packages/agent-core/src/runtime/commands/planCommands.planRuntime.test.ts
  - packages/agent-core/src/runtime/toolContext/planCapabilities.ts
  - packages/agent-core/src/runtime/toolContext.planRuntime.test.ts
---

# 命令与模型工具共享同一计划持久化屏障

## 目标
宿主 plan 命令与模型 plan capability 通过一个 adapter 获得完全相同的 durability、失败中断和恢复事件语义。

## 交付边界
共享 adapter、两个入口接线和共享契约测试一起交付；入口各自的 capability guard 与 fallback run 行为保留。

## 上下文
- `commands/planCommands.ts` 与 `toolContext/planCapabilities.ts` 复制了 `withoutUndefined`、异常格式化、失败中断、trace event、persist result 校验和 runtime binding。
- 新模块只能负责 plan persistence barrier，不成为 runtime 通用 helper。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- `CoreInstance`、sessionId、可选 fallback `RunState`。
### 产出
- 创建 persisted `PlanRuntime` 的单一 adapter，或等价的窄接口。

## 验收标准
1. 两套现有 plan runtime 测试和新增共享 adapter 测试全部通过。
2. persistence throw、非 saved outcome、session 消失、fallback run 四类场景在两个入口语义一致。
3. `pnpm exec tsc -b packages/agent-core/tsconfig.json` → 通过。

## 执行记录（仅编排者回写）
- 2026-09-03：依赖 006 完成，派发执行 agent，base `7939d09`。
- 2026-09-03：首审 REJECTED；R1 要求复用同一 adapter，并覆盖 rollback factory 调用次数与 fallback 持久化。
- 2026-09-03：R1 独立复审 APPROVED；编排者复跑 19 tests 通过，准予提交。
