---
id: "030"
title: 查询 rollout 五表
kind: leaf
parent: "2000"
depends_on: ["020"]
discovered_from: null
model: gpt-5.6-sol
status: done
repair_round: 2
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/host-node/src/rollout/queryCursor.ts
  - packages/host-node/src/rollout/queryCursor.test.ts
  - packages/host-node/src/rollout/queryRepository.ts
  - packages/host-node/src/rollout/queryRepository.test.ts
  - packages/host-node/src/rollout/queryPageBudget.ts
  - packages/host-node/src/rollout/queryPageBudget.test.ts
  - packages/host-node/src/rollout/queryRepository.projector.test.ts
---

# 查询 rollout 五表

## 目标

实现 canonical list/items/read repository，只读取 rollout SQLite 投影。

## 接口

repository 注入 `SqlExecutor`，提供 `listHistories`、`listItems`、`readItem`；不认识 legacy、FTS、HTTP 或 core store。

- history target 从 catalog 的 kind/conversation/run/path 严格重建；未知/不完整 identity 失败。
- list 按 `updated_at DESC, history_id ASC`；itemCount 只算 `deleted=0`。
- status 取该 history 最新 turn/run state；root idle/running 等状态原样保留；complete 只信 catalog terminal 标记。
- items 按 `item_ordinal,item_id`，默认排除 tombstone，role filter 在有界 SQL/codec 后生效；preview 使用 020 helper。
- role filter 的“有界”同时限制单批与单请求累计扫描/解码行数；命中 scan cap 时即使零匹配也返回 warning 与
  绑定最后已扫描 key 的 continuation，下一页必须前进且不遗漏已匹配但未返回的项。
- read 精确匹配 target + itemId，已删除与不存在使用不同 code；分段读取稳定 JSON 文本。
- canonical item_json 超限、非法 ModelItem、catalog/state identity 损坏必须明确失败，不能当 legacy warning。
- 输出预算由 `queryPageBudget.ts` 对最终 result envelope（含 wrapper、warning、cursor）统一计算；不能靠预留常数。
  首条 summary 本身过大时必须明确报有界错误，不能返回无 cursor 的空截断页；正常截断必须有可前进 cursor。

`queryCursor.ts` 只负责严格 base64url JSON codec、filter normalization、snapshot/keyset 校验：

- global list snapshot 使用 append-only `agent_rollout_events` count；任何 append 使旧 cursor stale。
- target items snapshot 使用 catalog `last_rollout_ordinal`。
- cursor 绑定 query kind、规范化 filters、snapshot、last key；未知键/版本/类型拒绝。
- cursor 是稳定性边界，不是权限令牌。

## 验收

1. 真实临时 SQLite 五表覆盖多 root/child、跨 conversation、running/terminal、删除、reorder、pending、role filter。
2. 正常分页无重复遗漏；append 后 cursor 返回 `AGENT_HISTORY_CURSOR_STALE`；换 filter/target 拒绝。
3. read Unicode chunk 拼接等于完整稳定 JSON，单次不超过 20,000 code points。
4. repository 不 import `node:sqlite`、legacy archive、atoms、rollout projector/service。
5. `pnpm exec vitest run packages/host-node/src/rollout/queryCursor.test.ts packages/host-node/src/rollout/queryRepository.test.ts packages/host-node/src/rollout/projector.test.ts` 通过。
6. `pnpm exec tsc -b`、`pnpm check:boundaries` 与 owners `<=300` 通过。

## 禁止项

- 不修改 `projectionSchema.ts`、287 行 `projector.ts` 或 JSONL。
- 不做 search，不从 recovery snapshot 补 canonical 结果。
