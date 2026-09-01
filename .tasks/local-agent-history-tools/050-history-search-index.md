---
id: "050"
title: 建立 FTS5 派生索引
kind: leaf
parent: "2000"
depends_on: ["020", "030"]
discovered_from: null
model: gpt-5.6-sol
status: done
repair_round: 2
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/host-node/src/rollout/searchSchema.ts
  - packages/host-node/src/rollout/searchSchema.test.ts
  - packages/host-node/src/rollout/searchText.ts
  - packages/host-node/src/rollout/searchText.test.ts
  - packages/host-node/src/rollout/searchIndex.ts
  - packages/host-node/src/rollout/searchIndex.reconcile.test.ts
  - packages/host-node/src/rollout/searchIndex.query.test.ts
  - packages/host-node/src/rollout/searchCursor.ts
  - packages/host-node/src/rollout/searchCursor.test.ts
  - packages/host-node/src/rollout/searchReconciler.ts
  - packages/host-node/src/rollout/searchQuery.ts
  - packages/host-node/src/rollout/searchIndexFailure.ts
---

# 建立 FTS5 派生索引

## 目标

从 append-only rollout events 增量维护一个可删除、可重建的全文搜索索引。

## 表与职责

- `agent_history_search_fts`：FTS5 virtual table，索引 content；history_id/item_id/role/item_ordinal/updated_at 为身份或排序列。
- `agent_history_search_state`：每 history 的 schema version 与 `indexed_rollout_ordinal` watermark。
- 两表及 FTS shadow tables 都归本叶；不加入 rollout 五表常量，不修改 projector/rebuild 的“五表”语义。
- feature probe 用真实 `sqlite_compileoption_used('ENABLE_FTS5')` 加实际建表验证；不可用返回
  `SEARCH_INDEX_UNAVAILABLE`，不能 fallback 全表扫描。

## 增量与崩溃语义

- 从 catalog 找 `last_rollout_ordinal > indexed_rollout_ordinal` 的 history，再按 ordinal 有界读取 events。
- `item_upsert` decode event_json 并 upsert FTS；`item_deleted` 删除对应 row；其他 mutation 只推进 watermark。
- 每条 event 的 FTS mutation 成功后才推进 watermark；中间崩溃允许幂等重放。
- 单次 catch-up 有固定 event/history 上限；未追平返回 `SEARCH_INDEX_LAG`，后续调用继续，不在一个同步
  Node executor 调用里扫完全库。
- schema version 错或 FTS/shadow/state/MATCH 损坏只 drop/rebuild 本叶表并有界重试一次；仍不可用返回
  `SEARCH_INDEX_UNAVAILABLE`。canonical event/row decode/identity 损坏则稳定抛 `AGENT_HISTORY_SOURCE_CORRUPT`，
  两类不得混淆。JSONL append 与 rollout projection 不依赖 search 成功。
- `searchIndex.ts` 只组装 facade；event catch-up 在 `searchReconciler.ts`，MATCH/query/paging 在 `searchQuery.ts`，
  严格 cursor codec 在 `searchCursor.ts`，避免维护与查询堆进一个文件。

## 查询

- query 先 trim/长度校验，再由 `searchText.ts` 生成安全 FTS5 MATCH 表达式；不得字符串拼 SQL。
- 支持 target/all 与 roles filter；按 rank、updatedAt、historyId、itemOrdinal、itemId 稳定排序。
- snippet 最大 1,000 字符；cursor 绑定 query/filter、events snapshot、search watermark 与 last sort key。
- 搜索结果必须从 canonical identity 恢复完整 target；deleted item 永不返回。
- FTS hit 的 content/history/item/role/ordinal/createdAt 必须与 canonical item/decoded text 严格对拍；派生字段不一致
  触发本叶 drop/rebuild，canonical item/target/identity 本身非法则 fail-closed source-corrupt。

## 验收

1. 真实 Node SQLite 覆盖 probe success/fail、首次 build、item upsert/update/delete、run-only event、重复 reconcile。
2. 每条 event 后 watermark 才推进；故障注入后重试不重不漏；有界 lag 可连续追平。
3. target/all、role、Unicode、引号/操作符 query、稳定 rank/cursor/snippet 上限通过。
4. drop 两搜索表后只靠五表 events 重建结果等价；drop 搜索表不触碰 rollout 五表/JSONL。
5. `pnpm exec vitest run packages/host-node/src/rollout/searchSchema.test.ts packages/host-node/src/rollout/searchText.test.ts packages/host-node/src/rollout/searchIndex.reconcile.test.ts packages/host-node/src/rollout/searchIndex.query.test.ts` 通过。
6. `pnpm exec tsc -b`、`pnpm check:boundaries`、owners `<=300` 通过。

## 禁止项

- 不修改 `projector.ts`、`projectionSchema.ts`、rollout service 或 offline rebuild script。
- 不用 LIKE/全表 scan 作为 FTS failure fallback。
