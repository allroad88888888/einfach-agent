# 008 执行报告

## 摘要

- 在 `agent-core/subagents/types.ts` 新增模型档位、任务类别、风险等级的只读值集合，并由对应 union type 派生；`SubagentToolProfile` 改由 `toolProfile.ts` 的只读 tuple 派生。
- `DelegateAgentChildSpec/Input.confirmedTools` 改为 `DelegatableDangerousTool[]`；normalizer 仍从 `unknown` 严格筛选并拒绝 MCP/未知工具。
- `DANGEROUS_TOOLS` 保持根级内建危险工具全集 owner；`DELEGATABLE_DANGEROUS_TOOLS` 是以 `satisfies readonly DangerousTool[]` 静态证明的显式子集，不会使未来 root-only 危险工具自动可委派。
- delegate_agent 的 JSON schema、输入 normalizer 错误文案与 guide 均改为消费或由上述能力集合锁定。
- guide 补齐 `workspace_verify`、其专属的 `run_verification_command`、完整的 verify → read → delegate 收窄阶梯，以及 `delete_path`、`copy_path`、`move_path`、`revert_workspace_change`。

## 逐项验收

1. **agent-core subagent input、tool profile 与 delegate-agent 测试通过。**
   - 命令：`pnpm exec vitest run packages/agent-core/src/subagents/input.test.ts packages/agent-core/src/subagents/toolProfile.test.ts packages/agent-core/src/subagents/continuationDescriptor.test.ts packages/agent-core/src/runtime/dangerousTools.test.ts packages/agent-core/src/runtime/dangerousTools.mcpToolCall.test.ts packages/agent-core/src/runtime/toolContext.workspaceRoot.test.ts tools/agents/src/delegate-agent/delegate-agent.test.ts`
   - 结果：7 个测试文件、96 个测试全部通过。
2. **schema、normalizer、guide 与 canonical values 一致。**
   - `input.test.ts` 遍历模型档位、任务类别、风险等级、tool profile 与全部可委派危险工具，确认 normalizer 接受每个 canonical value。
   - `delegate-agent.test.ts` 对拍根/child JSON schema enum 与公开能力集合；guide 测试只解析 `Allowed values:`/`Accepted names:` 片段，分别锁定根与 child tool profile 的展示，避免任意 prose backtick 误入枚举。
   - guide 测试另锁定 `workspace_verify` 的专属 `run_verification_command` 与完整收窄阶梯。
3. **危险能力未放宽。**
   - root 危险全集和可委派子集分别定义；类型层以 `satisfies` 限定子集元素属于根集合，`dangerousTools.test.ts` 再逐项验证子集关系。`isDelegatableDangerousTool` 只接受子集字面值，MCP 仍被排除。
4. **文件职责与行数。**
   - 本任务改动后的所有源码、测试与 guide 文件均不超过 300 行；最大为 `dangerousTools.ts` 的 297 行。
5. **diff 完整性。**
   - `git diff --check` 通过。

## 未验证

- `pnpm exec tsc -b packages/agent-core/tsconfig.json tools/agents/tsconfig.json` 未取得成功退出码：构建被范围外多个 `tools/**` 的 `*.md?raw` TS2307 缺失声明阻断。输出未包含本任务文件的 TypeScript 错误。

## 范围外发现

- 工作区同时存在 003、007 等并行任务的未提交改动及任务文档；均未修改、暂存或还原。
- 全量 TypeScript 构建的 raw Markdown 模块声明问题不在本任务 files 边界内。
- 因 `confirmedTools` 公开类型收紧，两个既有测试 fixture 需同步：`continuationDescriptor.test.ts` fixture 改为合法的 `write_file`，`toolContext.workspaceRoot.test.ts` 的 MCP 纵深防御用例显式断言为 `DelegatableDangerousTool[]` 后继续验证运行时拒绝。二者未改变产品行为。

## 疑虑

- 无新增疑虑。

## 建议

- 由 tools/构建配置责任方修复 `*.md?raw` 模块声明后，重跑指定 TypeScript 构建。

## 回执（四态）

- 实现：完成
- 定向测试：完成
- 指定构建：未验证
- 范围纪律：完成

原因：能力集合、类型契约、guide 对拍与定向测试均已完成；指定 TypeScript 构建仅受范围外 raw Markdown 模块声明缺失阻断。
