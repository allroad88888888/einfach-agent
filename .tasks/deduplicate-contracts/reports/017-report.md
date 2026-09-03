# 017 当前轮边界只保留一个可导入实现

状态：`DONE_WITH_CONCERNS`

## 改动摘要

- 删除 `runtime/commands/turnSafety.ts` 中零消费、忽略 `turnId` 的旧 `currentTurnStartIndex` 实现。
- `turnSafety.ts` 现只导出 `currentTurnHasSideEffects`。
- 新增非空的 `turnSafety.test.ts`，锁定安全工具、`run_task` 与危险工具的副作用判定，确认删除旧 helper 未改变既有职责。

## 验收命令与结果

| 命令 | 结果 |
| --- | --- |
| `rg -n "function currentTurnStartIndex" packages/agent-core/src/runtime` | 通过：仅 `activeTurnItems.ts:12` 的 canonical owner。 |
| `pnpm exec vitest run packages/agent-core/src/runtime/activeTurnItems.test.ts packages/agent-core/src/runtime/commands/turnSafety.test.ts` | 通过：2 个测试文件、5 个测试。 |
| `git diff --check -- <任务 files>` | 通过：无空白错误。 |
| `wc -l`（任务文件） | 通过：最大 35 行，均低于 300 行。 |

## 类型与构建验证

- `pnpm exec tsc -p packages/agent-core/tsconfig.json --noEmit` 未通过：
  - 仓库既有的 `tools/**.md?raw` 模块声明缺失（TS2307）。
  - 018 并行任务未提交改动在 `packages/agent-core/src/subagents/childAgentLoop.ts:146` 造成 `readonly string[]` 到危险工具联合类型的 TS2322。
- 按任务卡进一步运行 `pnpm build`，同样被 018 并行任务范围外的 `packages/agent-core/src/subagents/delegationBatch.ts:132` TS2345 阻断，未进入本任务改动路径。

## 静态核对

- 全仓 runtime 范围仅有一个 `function currentTurnStartIndex` 定义，位于 `activeTurnItems.ts`。
- `turnSafety.ts` 不再实现或导出 current-turn 起点查找。
- `activeTurnItems.test.ts` 已覆盖 turnId 锚点、缺失锚点回退到最后 user、无 user 回退零点；本次未改变 canonical 实现。

## 范围外发现

- 工作区有 018、019、020 并行任务的未提交改动；未修改、暂存或还原它们。
- 018 当前未提交类型收窄导致上述 `childAgentLoop.ts` 与 `delegationBatch.ts` 类型检查/根构建阻断。
- 项目 TypeScript 构建还缺少 `*.md?raw` 模块声明；本任务 files 边界外，未修改。

## 疑虑

- 产品行为和定向回归测试已通过，但 package TypeScript 与根构建无法在当前并行工作树取得全绿，原因均在任务边界外。

## 建议后续动作

- 在 018 类型问题修复并补齐 raw Markdown 模块声明后，重新运行 agent-core 类型检查和根构建。
- 由编排者按本任务 files 范围复核并创建独立提交。
