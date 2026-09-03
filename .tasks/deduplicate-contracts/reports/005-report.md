# 005 执行报告

## 摘要

- 在 `@einfach-agent/core/history` 建立 history target 的唯一运行时契约：严格 root/child decoder、存储 identity、无 delimiter 碰撞的 key/equality、可由调用方注入字符串上限的 JSON Schema builder。
- `historyQuery.ts` 现在唯一持有 readonly run/history status、item role 与查询 envelope 限额；`AgentRunStatus` 和 `AgentHistoryStatus` 均由这些 values 派生。
- host history/rollout 的输入归一化、两类 cursor、rollout codec、legacy root 去重、append/projector identity 均改为消费 core 契约。
- legacy v1 service cursor 在比较新旧 filters 时先用 core decoder 语义规范化 target，兼容升级前由公开 capability 保留的非 canonical 属性插入顺序，且不改变 v1 envelope。
- 新增单一职责的 `historyTargetSql.ts`，统一 SQLite target 行解码和 null-aware root/child predicate；query 与 search 只保留各自查询拼接。
- 四个 agent history 工具的 target schema、status/role enum 和查询限额全部从 core 契约生成/引用。
- 保留不同 envelope 的边界：query target 每字段上限仍为 1,000；rollout record target 仍沿用其 512 KiB 字符串上限，并有 >1,000 字符回归测试。

## 逐项验收

1. **agent-core history、host history/rollout 与四个工具测试**：通过。
   - 命令：`pnpm exec vitest run --maxWorkers=2 --testTimeout=10000 packages/agent-core/src/history packages/host-node/src/history packages/host-node/src/rollout tools/agents/src/list-agent-histories tools/agents/src/list-agent-history-items tools/agents/src/read-agent-history-item tools/agents/src/search-agent-histories`
   - 结果：R1 完整复跑 40 files passed，215 tests passed。
   - 发布构建：`pnpm --filter @einfach-agent/core build`、`pnpm --filter @einfach-agent/host-node build`、`pnpm --filter @einfach-agent/tools-agents build` 全部通过。

2. **消费层不再维护 status/role enum literals 与 target equality**：通过。
   - `rg -n "function (sameTarget|targetKey)|const (sameTarget|targetKey)|left\\.kind === right\\.kind" packages/host-node/src/history packages/host-node/src/rollout tools/agents/src/{list-agent-histories,list-agent-history-items,read-agent-history-item,search-agent-histories}` 无输出。
   - `rg -n "'idle'.*'running'.*'awaiting_tool'|'system'.*'user'.*'assistant'.*'tool'" packages/host-node/src/history packages/host-node/src/rollout tools/agents/src/{list-agent-histories,list-agent-history-items,read-agent-history-item,search-agent-histories} -g '!*.test.ts'` 无输出。
   - `rg -n "oneOf: \\[|maximum: (100|50|20_000)|maxLength: (1_000|10_000|100_000)" tools/agents/src/{list-agent-histories,list-agent-history-items,read-agent-history-item,search-agent-histories} -g '!*.test.ts'` 无输出。
   - core 契约测试覆盖 exact shape、缺字段/多字段、identity 往返、NUL delimiter 碰撞与 caller-owned string bound。

3. **cursor、legacy、SQLite query 的 root/child 行为一致**：通过。
   - query cursor 新增 histories/items child target 往返；search cursor 新增 child target 往返。
   - legacy service cursor 新增两个手工构造的升级前 v1 payload：items/root 使用 `conversationId,kind` target 顺序，search/child 使用 `agentPath,runId,conversationId,kind` 顺序；均可与当前 decoder 重建的 canonical target 语义匹配。测试没有调用 current encoder 构造旧 payload。
   - legacy root canonical suppression 改用 core key/equality，既有 legacy root/child 全套测试通过。
   - SQLite helper 测试覆盖 root 的 `run_id/agent_path IS NULL`、child 四字段 predicate、root/child 行解码及不一致 identity 拒绝。
   - repository 测试新增 child 定向 list；search 既有 child target 过滤测试继续通过。

4. **指定联合 TypeScript 命令**：未通过，但未发现本任务类型错误。
   - 命令：`pnpm exec tsc -b packages/agent-core/tsconfig.json packages/host-node/tsconfig.json tools/agents/tsconfig.json`
   - 结果：仅报仓库既有的 `TS2307 Cannot find module './*.md?raw'`，涉及 tools/agents、tools/fs、tools/interaction、tools/planning、tools/shell、tools/skills、tools/vision；无 005 产品代码类型错误。
   - 佐证：`pnpm exec tsc -p packages/host-node/tsconfig.json --noEmit` 通过；三个目标包各自的完整发布 build（含各自 declaration emit）全部通过。

## 未验证

- 无法在不修改任务 files 之外 tsconfig/raw module 声明接线的前提下，让验收标准 4 的联合 `tsc -b` 返回 0。

## 范围外发现

- 联合 build 模式下，`packages/agent-core/tsconfig.json` 经路径映射拉入多个 tools 源文件，却没有同时纳入这些包各自的 `raw-modules.d.ts`；因此即使 `tools/agents/src/raw-modules.d.ts` 存在，联合命令仍报所有 `*.md?raw` 为未声明模块。该问题在 005 基线之外，未修改。
- 完整测试首次使用默认高并发时，`sourcePreflight.test.ts` 的 5 秒用例超时；单文件复跑 7/7 通过，随后以 2 workers、10 秒超时完整复跑 R0 的 213/213、R1 的 215/215。未改动该无关测试的超时策略。

## 疑虑

- 验收标准 4 的原命令仍为红色，尽管包级 build 和 005 全量测试均为绿色；因此回执采用 `DONE_WITH_CONCERNS`。

## R1 修复记录

- 已关闭首审唯一 Important：`historyServiceCursor.ts` 的 `stable()` 现在对比较两侧的 `filters.target` 调用 `decodeAgentHistoryTarget`，再进行既有 roles 排序与 JSON 比较；旧 payload 的 target 属性顺序不再参与 cursor identity。
- v1 的 `{ v, kind, filters, offset }` envelope、base64url canonical 检查、kind/offset/filter 变更拒绝及 cursor 长度上限均保持不变。
- 定向验证：`pnpm exec vitest run packages/host-node/src/history/historyServiceCursor.test.ts` → 1 file / 5 tests passed。
- 类型与构建：`pnpm exec tsc -p packages/host-node/tsconfig.json --noEmit` 与 `pnpm --filter @einfach-agent/host-node build` 均通过。

## 建议

- 后续在独立构建任务中为跨包 source-path typecheck 提供统一 `*.md?raw` ambient declaration，或避免 agent-core typecheck 穿透到 tools 源码；修复后复跑验收标准 4。
- reviewer 审查新增未跟踪文件时需显式包含 `packages/host-node/src/rollout/historyTargetSql.ts` 与 `historyTargetSql.test.ts`，普通 `git diff <base>` 不会显示未跟踪文件。
