# 050 执行报告

状态：DONE

## 交付

- 新增独立 FTS5 派生 schema：同时验证 `ENABLE_FTS5` 编译选项、实际建表与查询；损坏时只删除并重建搜索表和 watermark，rollout 五表不在搜索表常量中。
- 新增按 history 的 schema version / indexed ordinal watermark；从 append-only events 按 history、event 双上限追赶，FTS mutation 成功后才推进 watermark，崩溃重放幂等。
- `item_upsert` 更新 role/content/ordinal/timestamp，`item_deleted` 移除命中，其他事件只推进 watermark；有限追赶返回 `SEARCH_INDEX_LAG`，FTS5 不可用返回 `SEARCH_INDEX_UNAVAILABLE`，均无 LIKE/全表扫描 fallback。
- 新增安全 MATCH 文本生成器：trim 后按 Unicode code point 执行 1–1,000 限制，把用户 token 全部作为字面短语，不允许引号/操作符注入 FTS 语法。
- 新增严格 versioned base64url search cursor，绑定规范化 query/target/roles、events count、全局 indexed watermark 与完整 rank keyset；filter 改变报 invalid，事件或 watermark 改变报 stale。
- 查询支持 global/target、role filter、稳定 `rank ASC, updatedAt DESC, historyId, itemOrdinal, itemId` 排序；从 canonical catalog/items 恢复完整 target 与 item summary，排除 deleted，snippet 按 Unicode code point 限制为 1,000。
- 文件按 schema/text/cursor/reconciler/query/facade 单一职责拆分，未修改 projector、projection schema、rollout service、任务/index 或并行 040 owners。

## 验证

- 真实 `node:sqlite` 定向 Vitest：5 files / 12 tests 通过；覆盖 probe success/fail、首次 build、bounded lag 连续追平、run-only watermark、upsert/update/delete、重复 reconcile、watermark 前故障与幂等重试、drop/rebuild、schema mismatch rebuild、global/target/role/rank/cursor/stale/snippet/unavailable。
- `pnpm exec tsc -b --pretty false`：通过。
- `pnpm check:boundaries`：通过，仅仓库既有豁免观察项。
- `pnpm check:state`：通过。
- owners `git diff --check`：通过。
- owner 行数：41 / 63 / 100 / 72 / 40 / 133 / 78 / 32 / 45 / 17 / 14，全部 `<=300`。

## 裁决

- lag 时返回当前有界索引结果并附明确 warning；cursor 同时绑定 events snapshot 与 indexed watermark。理由：同步 executor 每次调用保持严格有界，同时任何后续追赶都会使旧 cursor 稳定 stale，不能把不同索引快照混成一页。
- upsert 使用 delete+insert 幂等 mutation，watermark 独立后置。理由：SqlExecutor 没有事务接口；任一中间故障会让本次 search 整体失败，重试会恢复唯一一行且不漏事件。

## 关注项

无。

## R1：故障分类、自愈与严格对拍

状态：DONE

- 新增单一职责 `searchIndexFailure.ts`，区分可丢弃 derived search failure 与需要主动 probe 判责的混合 MATCH/JOIN SQL failure。
- schema probe 现在实际覆盖 state 三列写入、FTS 七列写入、MATCH 命中与 FTS/state 删除；state 错列、schema version mismatch、FTS/shadow/MATCH 损坏统一 drop/recreate 本叶表。
- facade 对 derived 故障执行一次且仅一次 drop/recreate + bounded reconcile/query 重试；再次失败返回 `SEARCH_INDEX_UNAVAILABLE`。混合 SQL 失败先跑独立 active probe，probe 健康则稳定抛 `AGENT_HISTORY_SOURCE_CORRUPT`，canonical typed error 原样保留。
- query 同时读取 FTS content/identity/role/ordinal/createdAt 与 canonical catalog/items 字段；canonical item JSON、target、identity、flags 严格 decode，坏行 typed source-corrupt；所有派生字段逐项与 canonical decoded item 对拍，不一致触发自愈。
- cursor 增加递归 exact target shape、非空 identity、非负 safe-integer snapshot/updatedAt/itemOrdinal 与 finite rank 校验；root/child 多余键、空字段、负数、小数、overflow 均拒绝。
- page budget 改用公共 `AGENT_HISTORY_PAGE_MAX_CHARS`，不再硬编码数值。

### R1 验证

- 扩展真实 `node:sqlite` 定向 Vitest：5 files / 17 tests 通过；新增 state 错列、真实 shadow table 破坏、自愈重建、逐列 FTS 篡改、canonical 坏 row 分类与严格 cursor 反例。
- `pnpm exec tsc -b --pretty false`、`pnpm check:boundaries`、`pnpm check:state`、owner `git diff --check`：全部通过。
- 十二个 owner 行数：62 / 90 / 141 / 73 / 84 / 23 / 153 / 87 / 52 / 67 / 17 / 14，全部 `<=300`。

## R2：state 判责与一次性 row decode

状态：DONE

- search-state 的 schema count、history watermark、lag count 与 watermark sum 全部改为 derived decode；负数、小数、TEXT 或非 safe integer 不再误报 canonical corruption，而是只 drop/recreate 搜索表并执行一次有界重建。
- catalog/state mixed history SELECT 与 lag-summary SQL 统一使用 mixed failure marker；facade 以 active probe 判责。probe 失败进入 derived 自愈，probe 健康则 fail-closed `AGENT_HISTORY_SOURCE_CORRUPT`。覆盖 ensure 后 state 被删除的 history-select 与 lag-summary 两个竞态窗口。
- mixed row 仍独立校验 canonical `history_id` 与 `last_rollout_ordinal`；非法 catalog ordinal 保持 source-corrupt，不会因同查询读取 state 而降级。
- search row 现在只解码一次为已验证 `{ hit, key }`：rank、canonical `updated_at`、history/item identity 与 ordinal 都在统一 typed boundary 内验证。单命中同样验证，cursor 与输出预算只消费已验证结构，不再读取 raw SQL row。

### R2 验证

- 扩展真实 `node:sqlite` 与受控 executor 定向 Vitest：5 files / 28 tests 通过；新增负/小数/TEXT watermark、state count/sum decode、ensure→reconcile race、canonical catalog ordinal、单命中/分页坏 `updated_at`。
- `pnpm exec tsc -b --pretty false`、`pnpm check:boundaries`、`pnpm check:state`、owner/report `git diff --check`：全部通过。
- 十二个 owner 行数：62 / 90 / 158 / 124 / 90 / 23 / 155 / 96 / 52 / 67 / 17 / 14，全部 `<=300`。
