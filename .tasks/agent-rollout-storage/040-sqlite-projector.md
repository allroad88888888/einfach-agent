---
id: "040"
title: 实现可重放 SQLite 投影
kind: leaf
parent: "2000"
depends_on: ["010", "030"]
discovered_from: null
model: gpt-5.6-sol
status: done
repair_round: 2
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/host-node/src/rollout/projectionSchema.ts
  - packages/host-node/src/rollout/projectionSchema.test.ts
  - packages/host-node/src/rollout/projector.ts
  - packages/host-node/src/rollout/projector.test.ts
---

# 实现可重放 SQLite 投影

## 目标

把 rollout JSONL 幂等投影到 SQLite catalog/items/turns/state，使投影可落后、可删除并从 source 重建。

## 上下文

当前 SQLite executor 一次执行一个 statement，没有现成 transaction API。因此 crash-safe 不能依赖伪事务：
先做幂等 upsert，再推进 byte offset；两步之间崩溃会重放同一 record，但结果不重复。

## 表职责

- `agent_rollout_catalog`：history target、首次/最后记录时间、完整性状态。
- `agent_rollout_events`：按 `(history_id, rollout_ordinal)` 去重并保留事件索引。
- `agent_rollout_items`：按稳定 item id 投影最新内容、item ordinal、最后变更 ordinal与 tombstone。
- `agent_rollout_turns`：投影 turn context/run state，不复制 item JSON。
- `agent_rollout_projection_state`：source path、下一 byte offset、下一 rollout ordinal。

schema 只含未来 list/read 所需字段；本叶不建 FTS 表、不定义搜索排名。

## 验收标准

1. 五种 mutation 投影正确；item update/reorder/delete 保留最后状态与事件审计。
2. 在 item upsert 后、offset 更新前注入崩溃，再次 reconcile 不产生重复 event/item。
3. 多 history 独立维护 byte offset；首条 record 后固定 source 的 historyId 与完整 target，任何漂移报 corruption；
   半行不推进 offset，并返回文件/offset 诊断。reconcile 从 persisted offset 有界分块读取，不整文件载入。
4. 删除全部投影表后，从 JSONL 重建得到相同 catalog、items、turns 与 state。
5. `pnpm exec vitest run packages/host-node/src/rollout/projectionSchema.test.ts packages/host-node/src/rollout/projector.test.ts` → 通过。
6. schema 与 projector 分文件且各不超过 300 行；测试使用真实临时 SQLite 文件。

## 禁止项

- 不把 SQLite 变成 source of truth，不修改 JSONL。
- 不添加 FTS、snippet、cursor 或对外查询 API。
