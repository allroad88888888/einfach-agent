# 007 命令与模型工具共享同一计划持久化屏障

## 改动摘要

- 新增 `runtime/planPersistence.ts`：该领域 adapter 统一绑定 `PlanRuntime` 的读写存储、恢复快照 durability fence、失败时的 interrupted run、trace event 与按持久化调用传入的 fallback `RunState` 语义。
- `commands/planCommands.ts` 与 `toolContext/planCapabilities.ts` 均消费同一 adapter；命令入口保留未注入 runtime 的提示及 rollback fallback run，模型工具入口保留原有 stale guard 与能力缺席行为。
- 新增 `planPersistence.test.ts` 覆盖持久化抛错、非 saved outcome、session 消失、fallback run 四种共享屏障场景；命令测试另覆盖真实 checkpoint rollback 分支复用首次 adapter。

## 逐条验收

1. 两套既有 plan runtime 测试与新增共享 adapter 测试。
   - 通过：`pnpm exec vitest run packages/agent-core/src/runtime/planPersistence.test.ts packages/agent-core/src/runtime/commands/planCommands.planRuntime.test.ts packages/agent-core/src/runtime/toolContext.planRuntime.test.ts`
   - 结果：3 个测试文件、19 个测试全部通过。
2. persistence throw、非 saved outcome、session 消失、fallback run 的入口语义一致。
   - 通过：四类场景均由 `createPlanPersistenceAdapter` 的唯一实现覆盖；两个入口均只取得该 adapter 的 `planRuntime`。checkpoint rollback 复用首次 adapter 的 `persist('plan.stage_rollback', stoppedRun)`，测试断言 runtime factory 仅调用一次、reason 正确、interrupted run 与 trace 均使用 stopped run 的 `runId`。
3. `pnpm exec tsc -b packages/agent-core/tsconfig.json`。
   - 未通过：构建被范围外 `tools/**` 中 `*.md?raw` 模块的 TS2307 阻断。相关 sibling tool 包已有 `raw-modules.d.ts`，但 agent-core 的 TypeScript program 经 path alias 跟入其源码时未纳入这些 ambient declarations；输出未包含本任务文件的 TypeScript 错误。
4. 文件职责与行数。
   - 通过：新增 adapter 77 行、测试 116 行；修改后的命令文件 110 行、capability 文件 47 行，均低于 300 行。
5. `git diff --check`。
   - 通过：无空白错误。

## 未验证

- 因上述范围外 TypeScript 模块解析错误，无法取得指定全量 `tsc -b` 的成功退出码。

## 范围外发现

- sibling tool 包已有 `raw-modules.d.ts`，但 agent-core 的 TypeScript program 经 path alias 跟入其源码时未纳入这些 ambient declarations，导致 `tools/**` 的 `*.md?raw` TS2307；未修改 program/include/types 接线，避免越出 files 边界。
- 工作区存在其他并行任务的未提交改动；未修改、暂存或还原。

## 疑虑

- 指定 TypeScript 验收命令未全绿，虽失败均位于任务范围外，最终集成前仍应在声明修复后复跑。

## 建议

- 由 tools/tsconfig 责任方调整 TypeScript program 的 include/types/project 接线，使 sibling tool 包的既有 `raw-modules.d.ts` 被纳入，然后重跑指定 TypeScript 构建。

## 回执（四态）

- 实现：完成
- 定向测试：完成
- 指定构建：未验证
- 范围纪律：完成

原因：共享 adapter 与定向测试已交付，但全量 TypeScript 构建未纳入 sibling tool 包既有的 raw Markdown ambient declarations。
