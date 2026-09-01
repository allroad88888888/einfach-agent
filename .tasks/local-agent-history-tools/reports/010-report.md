# 010 执行报告

状态：DONE

## 交付

- 新增 `packages/agent-core/src/tools/context.ts`，作为唯一的 `ToolContext` 定义处；迁移其专属委派选项，并保持既有能力形状。
- 在该上下文加入可选只读 `agentHistory?: AgentHistoryCapability` 槽，直接引用 020 的 transport-neutral 合同；未做任何 provider 装配或工具行为改动。
- `tools/types.ts` 兼容重导出同一 `ToolContext`，保留 `Tool`、`ToolResult` 及 workspace/shell DTO。
- `tools/index.ts` 直接从 `context.ts` 公开 `ToolContext` 与 `SpawnAgentsOptions`，没有第二份结构合同。

## 验证

- `rg -n "interface ToolContext" packages/agent-core/src/tools`：仅 `context.ts` 一处。
- `pnpm exec vitest run packages/agent-core/src/runtime/toolContext.workspaceRoot.test.ts packages/agent-core/src/runtime/toolContext.verifyProfile.test.ts`：通过，2 files / 15 tests。
- `pnpm exec tsc -b`：通过。
- `pnpm check:boundaries`：通过，仅输出仓库既有观察项。
- `pnpm check:state`：通过。
- `git diff --check -- <010 owners>`：通过。
- owner `wc -l`：types 143、context 115、index 126，均 <=300。

## 关注项

- 额外执行 `pnpm --filter @einfach-agent/core build` 时，tsup 成功，但已有非 owner 文件 `src/state/persistence/modelMigration.ts:25` 的 `DeepSeekReasoningEffort` 类型不兼容使随后 `tsc -p tsconfig.build.json` 失败；本叶未修改该文件，也未更改其类型。
