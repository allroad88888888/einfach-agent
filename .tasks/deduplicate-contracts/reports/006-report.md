# 006 当前轮边界收敛报告

## 改动摘要

- 在 `activeTurnItems.ts` 新增并导出纯函数 `currentTurnStartIndex(items, turnId)`；规则为：优先匹配 `turnId`，未命中时定位最后一条 user，均不存在时返回 0。
- `currentTurnItems`、`unresolvedToolCalls`、恢复准入 `requiresToolReconciliation` 都改为消费此函数，并删除 `turnStart` 与 `currentRunStart` 私有副本。
- 新增 `activeTurnItems.test.ts` 和 `toolCallOutcomeFacts.test.ts`；扩展恢复继续测试。三个 consumer 均覆盖锚点命中、锚点丢失回退、无 user 的边界契约。

## 验收

1. `pnpm vitest run packages/agent-core/src/runtime/activeTurnItems.test.ts packages/agent-core/src/runtime/toolCallOutcomeFacts.test.ts packages/agent-core/src/runtime/commands/recoveryCommands.continue.test.ts`
   - 通过：3 个测试文件，17 个测试。
2. `rg "function (turnStart|currentRunStart)" packages/agent-core/src/runtime`
   - 通过：无匹配，三份私有边界实现已消除。
3. `pnpm exec tsc -b packages/agent-core/tsconfig.json`
   - 未通过，失败原因与本任务无关：`tools/**` 内 43 个 `*.md?raw` 导入找不到对应模块/声明，例如 `tools/agents/src/cancel-agent/cancel-agent.ts` 的 `./cancel-agent.md?raw`。本次未修改这些范围外文件。

## 未验证

- 完整 TypeScript project build 因上述既有范围外缺失文件无法完成；本任务触及的三个定向 Vitest 文件均已通过。

## 范围外发现

- 工作区同时存在其他并行任务对 provider、subagent 和任务树文件的改动；未修改、暂存或还原它们。
- `pnpm exec tsc -b packages/agent-core/tsconfig.json` 的构建图包含 `tools/**`，其 Markdown raw-import 输入或声明在当前工作区缺失。

## 疑虑

- 无实现层疑虑。类型构建未能作为最终全量验证信号，原因见验收第 3 条。

## 建议

- 在编排者集成前补齐或恢复 `tools/**` 的 Markdown raw-import 生成输入/声明后，重跑任务定义的 TypeScript build 命令。
