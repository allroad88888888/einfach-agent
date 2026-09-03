# 007 R1 独立复审

## 结论

**APPROVED**

原 Important 已修复：checkpoint 命中路径复用首次创建的 persistence adapter，`persist(reason, fallbackRun)` 只执行 durability barrier，不会再次实例化 `PlanRuntime`；新增真实命令测试完整约束了该回归点。

## 复审范围

- 仅复核上一轮 Important：checkpoint rollback 的 adapter/runtime factory 生命周期。
- 读取更新后的 `007-report.md`、当前任务 diff、`planPersistence.ts`、`planCommands.ts` 与命令测试。
- 按要求未重跑测试，未修改产品代码或任务文档。
- 无 checkpoint 时重新创建带 fallback run 的 runtime 是基线已有的降级业务分支，本轮明确不将其计为审查发现。

## Findings

### Critical

无。

### Important

无。原 Important 已关闭。

### Minor

无与本轮定向复审相关的新问题。

## 原 Important 核对

### 1. checkpoint 命中路径复用同一 adapter

- `packages/agent-core/src/runtime/commands/planCommands.ts:68-69` 在 rollback 开始时仅创建一次 `planPersistence`，并从中取得 `initialRuntime`。
- checkpoint 命中后，`packages/agent-core/src/runtime/commands/planCommands.ts:94` 调用同一个实例的 `planPersistence.persist('plan.stage_rollback', stoppedRun)`。
- 该路径不再调用第二次 `createPlanPersistenceAdapter`，因此不会额外执行 `core.planRuntime(...)`。
- `packages/agent-core/src/runtime/commands/planCommands.ts:84-91` 的无 checkpoint 分支仍按基线创建 fallback runtime 并调用 `rollbackStage`；这是原有业务分支，与已修复的 checkpoint 分支问题不同。

结论：**通过**。

### 2. `persist(reason, fallbackRun)` 不实例化 runtime

- `packages/agent-core/src/runtime/planPersistence.ts:11` 将 adapter 接口收窄为 `persist(reason, fallbackRun?)`。
- `packages/agent-core/src/runtime/planPersistence.ts:54-63` 的 `persist` 闭包只调用 `core.persistence.persistRecovery` 并处理失败 outcome；它不创建或读取 runtime。
- runtime 仍只在 adapter 创建时于 `packages/agent-core/src/runtime/planPersistence.ts:65-74` 绑定一次。
- 调用级 fallback 参数优先于 adapter 创建时的默认 fallback，因而首次 adapter 可以在 run 清空后使用刚捕获的 `stoppedRun`，无需重建 runtime。

结论：**通过**。

### 3. 真实命令测试覆盖完整

`packages/agent-core/src/runtime/commands/planCommands.planRuntime.test.ts:196-221`：

- 显式写入 `planStageCheckpointsAtom`，确保走 checkpoint 命中路径，而不是 fallback runtime 分支。
- 用 spy factory 断言 `toHaveBeenCalledTimes(1)`，直接防止第二次 runtime 实例化回归。
- 断言 `persistRecovery(sessionId, 'plan.stage_rollback')`，覆盖 session 与 reason。
- mock persistence rejection 后，断言恢复出的 run 为 `runId: 'run-1'`、`status: 'interrupted'`，并包含完整错误文本，证明使用的是清空前捕获的 stopped run。
- 断言 trace event 的 attrs 包含 `sessionId`、`runId: 'run-1'`、`reason: 'plan.stage_rollback'` 和原始错误文本，覆盖 fallback runId 的观测语义。

结论：**通过**。

## 报告一致性

更新报告对 R1 修复和新增 19-test 结果的描述与当前 diff 一致；其 TypeScript `*.md?raw` 范围外说明也已按上一轮意见澄清。本轮按要求未重跑报告测试，测试结果仅作为报告记录采信。

## 最终回执

**APPROVED — checkpoint rollback 已复用首次 adapter，调用级 fallback persist 不再实例化第二个 runtime，命令级回归测试覆盖 factory 次数、reason、stopped run 与 trace runId。**
