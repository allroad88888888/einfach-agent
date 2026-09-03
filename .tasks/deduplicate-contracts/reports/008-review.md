# 008 R2 独立复审

## 回执

**APPROVED**

R2 已关闭 R1 剩余的 1 个 Important 与 2 个 Minor；未发现新的 Critical、Important 或 Minor。

## Critical

无。

## Important

无。

## Minor

无。

## R1 剩余 finding 关闭情况

### 1. dangerous root set / child authorization 的旧绑定：已关闭

- `classifyToolRisk` 前的说明现明确写为“连接工具不进可委派子集；连接能力留在父级，root 风险由参数级分流决定”（`packages/agent-core/src/runtime/dangerousTools.ts:256-260`），不再宣称 `DANGEROUS_TOOLS` 同时决定 child 授权。
- 对应用例名已改为“connect 不在 delegatable subset，root 风险走参数级分流”，测试体继续断言 `isDelegatableDangerousTool(MCP_CONNECT_TOOL_NAME) === false`（`packages/agent-core/src/runtime/dangerousTools.test.ts:219-222`）。名称、断言和当前 root/subset 结构一致。

### 2. profile JSDoc 悬空：已关闭

- `packages/agent-core/src/subagents/types.ts:24-28` 已不再把 profile JSDoc 挂在 `SubagentArchiveWriteMode` 前。
- 三档 profile 的说明已迁到 canonical tuple owner `packages/agent-core/src/subagents/toolProfile.ts:3-15`；readonly values、派生 union 和文档现在同处一处。

### 3. 三份测试未完整登记/说明：已关闭

- 任务 frontmatter 已列入 `continuationDescriptor.test.ts`、`dangerousTools.test.ts`、`toolContext.workspaceRoot.test.ts`（`.tasks/deduplicate-contracts/008-delegate-contract.md:14-23`）。
- 报告在危险能力验收中点名 `dangerousTools.test.ts` 的逐项 subset 验证，并在范围说明中分别解释另外两份 fixture 因公开类型收紧而作的调整（`.tasks/deduplicate-contracts/reports/008-report.md:20-21,31-35`）。三份测试均有对应说明，“范围纪律完成”与任务清单一致。

## 复审边界

- 仅核对 R1 遗留项及其关联 current diff；未重新展开已关闭的 schema、normalizer、guide 和 MCP 验收。
- 按要求未重跑任何测试。
- 未修改产品代码或任务文档；仅覆盖本审查报告。
- TypeScript build 的范围外 `*.md?raw` 问题不纳入本次判断。

## 结论

R2 的修正仍位于“子 agent 委派”分支线的既有归属内，注释、测试名、owner 文档与任务范围记录均已对齐，可以批准。
