# 040 执行报告

状态：DONE_WITH_CONCERNS（R1 产品与定向验收完成；全仓类型门受 070 owner 的并行存量错误阻断）

## 交付

- 新增五张 rollout 投影表的幂等建表与定向删表：catalog、events、items、turns、projection state。
- 新增逐 JSONL history 的可重放 projector。每条 record 先以稳定主键幂等 upsert catalog/event/业务投影，再单独推进 source byte offset 与下一 ordinal。
- 五种 mutation 均有投影：session meta、turn context、item upsert、item deleted、run state；item 更新、重排、删除保留最新内容、ordinal、tombstone 与事件审计。
- 半行停在该行起始 byte offset，返回包含 source path 与 offset 的 `ROLLOUT_PARTIAL_LINE` warning；不同 source/history 独立记录 offset。
- 支持删除全部 rollout 投影表后，仅凭 JSONL 重建 catalog/items/turns/events/state。

## 崩溃重放证据

`projector.test.ts` 使用 `mkdtemp` 下的真实 JSONL 文件与真实磁盘 `node:sqlite` 数据库。故障钩子位于单条 record 的 catalog/event/item upsert 全部完成之后、projection state offset 写入之前；首次 reconcile 注入异常后确认 item/event 各一行，第二次 reconcile 从旧 offset 重放后仍各一行，并成功推进 offset。

## 验证

- `pnpm exec vitest run packages/host-node/src/rollout/projectionSchema.test.ts packages/host-node/src/rollout/projector.test.ts`：通过（2 files，4 tests）。
- `pnpm exec tsc -b`：通过。
- `pnpm check:boundaries`：通过（仅既有观察项）。
- `pnpm check:state`：通过。
- `wc -l`：schema 76、schema test 41、projector 171、projector test 127；均不超过 300 行。

## 文件职责

- `projectionSchema.ts`：只定义 rollout 查询投影的建表与删表。
- `projector.ts`：只负责从单个 JSONL source 幂等推进 SQLite 投影。
- 两个测试文件分别覆盖 schema 生命周期与 projector 重放行为。

## R1 修复

- 首条 record 立即固定 source 的 `historyId` 与完整逻辑 target；同次 reconcile 的后续记录逐条校验。已有 state 从 catalog 恢复完整 identity，跨次 reconcile 同样校验；state UPSERT 仅允许同 history 推进，不能改绑。
- JSONL 从 persisted byte offset 开始用固定上限 chunk 读取，不再整文件载入。跨 chunk 保留未完成行，半行保持 offset 不动；累计行超过 codec 上限立即受控失败，内存上界为单行上限加一个 chunk。
- 每条 `run_state` 都带 ordinal guard 将 catalog `complete` 重算为 terminal `1` / non-terminal `0`，新增 `done → running` 回归。
- identity 测试覆盖同文件混入 history、后续 reconcile 漂移完整 target；小 chunk 强制合法记录跨块；超长无换行记录覆盖有界失败。
- rebuild fixture 现包含 item update/reorder/delete、turn context 与 run state 合并；drop 前后对 catalog/items/turns/events/projection state 的全部列作深比较。

## R1 验证

- 定向 Vitest：通过（2 files，6 tests）。
- `pnpm exec tsc -p packages/host-node/tsconfig.json --noEmit`：通过。
- `pnpm check:boundaries`、`pnpm check:state`：通过。
- `pnpm exec tsc -b`：当前失败仅位于非 040 owner `packages/agent-core/src/subagents/childRolloutRecorder.test.ts`（TS2352/TS2493/TS2532），040 的 host-node 定向类型检查无错误；依约未跨 owner 修改。
- R1 行数：schema 76、schema test 41、projector 246、projector test 189；均不超过 300 行。

## R2 修复与验证

- 每个 newline 完整行在 `decodeAgentRolloutRecord` 与任何 SQLite projection 写入前，先用 newline 的 byte index 检查 `AGENT_ROLLOUT_MAX_LINE_BYTES`；超过上限立即按 source path/offset 报 corruption。
- 回归测试写入精确 `max + 1` 字节并追加 newline，使用 4097-byte chunk 强制该行跨多个 chunk；断言 catalog/events/items/turns/projection state 均为 0 行，证明 decode/project/state advance 前失败。
- 定向 Vitest：通过（2 files，6 tests）；host-node 定向 `tsc`、boundaries、state 均通过。
- `pnpm exec tsc -b` 仍只被非 040 owner 的 070 并行测试错误阻断：`childRolloutRecorder.test.ts` 与 `runtime.childRollout.test.ts`；未跨 owner 修改。
- R2 行数：schema 76、schema test 41、projector 249、projector test 194；均不超过 300 行。
