# 010 执行报告

状态：DONE_WITH_CONCERNS

修复轮次：R1

## 交付

- 新增 root/child 共用的 `AgentHistoryTarget`。
- 新增五种 rollout v1 mutation、persisted record、append/reconcile 结果与 `AgentRolloutDriver` 合同。
- 新增严格单行 JSON codec：拒绝未知 schema、未知/多余字段、非法 ordinal/timestamp/target/ModelItem、非单行输入，以及超出字节、深度、数组、对象键和字符串上限的数据。
- codec 对四种 `ModelItem` 逐角色校验，并 round-trip 保留 Unicode、tool call 与原始结构。
- 新增 `@einfach-agent/core/history` package export、tsup entry 与 boundary allowlist；未增加 299 行的 root `src/index.ts`。
- R1：`item_upsert` 新增必填 `pending: boolean` 与 `planStageId: string | null`，使 pending/plan stage 状态变化可被 producer 表达、投影并从 JSONL 重建。codec 要求两字段始终存在且严格校验类型，不在 decode 时制造隐式默认；producer 负责把 absent 规范化为 `false`/`null`。

## 验证

- `pnpm exec vitest run packages/agent-core/src/history`：通过，2 files / 12 tests。R1 新增两字段 round-trip、逐字段缺失和错误类型覆盖。
- `pnpm check:boundaries`：通过（仅输出既有豁免观察项）。
- `git diff --check -- packages/agent-core/src/history packages/agent-core/package.json packages/agent-core/tsup.config.ts scripts/check-boundaries.js`：通过。
- `wc -l`：新增产品文件最大为 `rolloutRecordCodec.ts` 244 行；其余新增产品文件均不超过 101 行；`packages/agent-core/src/index.ts` 保持 299 行。

## Concern

- `pnpm --filter @einfach-agent/core build` 的 tsup 阶段成功并产出新增 history entry，随后声明构建被任务范围外的既有类型错误阻断：`packages/agent-core/src/state/persistence/modelMigration.ts:25` 将 `"low" | "high" | "max"` 赋给不兼容的 `DeepSeekReasoningEffort`。本任务未获授权修改该文件。
- 额外执行 `pnpm exec tsc -p packages/agent-core/tsconfig.json --noEmit` 时，被任务范围外多个缺失的 `*.md?raw` 模块声明阻断；这些均位于 `tools/*`，未修改。

## 范围

只修改任务 frontmatter 列出的产品文件，并新增本报告；未修改任务/index、未提交。
