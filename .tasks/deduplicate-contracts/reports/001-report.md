# 001 归档恢复保留完整子 Agent 结果

## 改动摘要

- 新增 `archiveEventPayload.ts`，统一拥有 `child_started` / `child_finished` 的 v1 payload 编码与兼容解码。v1 为严格契约：未知版本或任一损坏字段（包括 `changeSets`）均拒绝；无版本历史事件保持兼容读取。
- replay 对被拒绝的版本化 child 事件写入可观察的 `parseErrors` 并跳过事件，不建节点、不生成默认成功结果。
- snapshot 解析保留“原始 snapshot 是否显式给出 objective”的来源信息。replay 的 objective 优先级为 finished → 显式 snapshot → started；缺失 snapshot objective 才允许 started 补值。
- producer 端的正常、失败/取消和蒸馏失败终态都使用显式 wire 字段投影；蒸馏失败不再以对象展开泄漏 `path` 等非 wire 字段。
- 新增真实 runtime archive JSONL→replay 回归，验证非空 `changeSets`、payload 版本和在线结果一致；另覆盖 v1 未知/损坏拒绝、snapshot 优先级、蒸馏失败 payload，以及旧事件兼容。

## 验收命令与结果

1. `pnpm vitest run packages/agent-core/src/subagents/runtime.requestConstruction.test.ts packages/subagents/src/archive/replay.test.ts packages/subagents/src/archive/replayRouteReason.test.ts`
   - 通过：3 个测试文件、16 个测试全部通过。
2. `pnpm vitest run packages/agent-core/src/subagents/runtime.requestConstruction.test.ts packages/agent-core/src/subagents/runtime.archiveReplay.test.ts packages/agent-core/src/subagents/runtime.budgetAndConcurrency.test.ts packages/subagents/src/archive/replay.test.ts packages/subagents/src/archive/replayRouteReason.test.ts packages/subagents/src/archive/replayChildPayload.test.ts packages/subagents/src/archive/replayTelemetry.test.ts`
   - 通过：7 个测试文件、30 个测试全部通过。
3. `pnpm exec tsc -b packages/agent-core/tsconfig.json packages/subagents/tsconfig.json`
   - 未通过：仅报出仓库既有 `tools/**` 的 `*.md?raw` 模块声明缺失（TS2307）。单独筛查后，本任务改动的 `agent-core/subagents` 与 `subagents/archive` 无 TypeScript 错误。
4. `git diff --check -- packages/agent-core/src/subagents packages/subagents/src/archive`
   - 通过：无空白错误。
5. `wc -l`（本任务新增或大改文件）
   - 通过：均不超过 300 行；`delegationBatch.ts` 为 300 行。

## 未验证项

- 未在磁盘持久化目录上执行恢复；真实 runtime 的内存 archive writer 已覆盖 producer→JSONL→replay 的完整数据路径。

## 范围外发现

- TypeScript 构建会纳入 `tools/**`，但仓库缺少 `*.md?raw` 模块声明；该问题不在本任务 files 边界内，未修改。
- `runtime.budgetAndConcurrency.test.ts` 是本任务前已存在的 372 行测试文件；为补蒸馏失败 producer 断言增加后为 376 行。未进行范围外的大规模测试拆分。
- 工作区同时存在其他任务改动；未修改、暂存或还原它们。

## 疑虑

- 指定 TypeScript 验收命令仍不能取得全绿退出码，原因仅为范围外的 raw Markdown 模块声明。

## 建议后续动作

- 由工具包/tsconfig 责任方补齐 `*.md?raw` 声明或收窄构建 include，然后重跑 TypeScript 验收。
- 后续触及 `runtime.budgetAndConcurrency.test.ts` 时，按测试场景拆分该存量超限文件。
