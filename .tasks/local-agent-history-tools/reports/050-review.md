# 050 独立复审

VERDICT: FAIL

严重度：Critical 0 / Important 4 / Minor 1

## Important

1. **raw hit 解码与身份损坏没有统一分类为 `AGENT_HISTORY_SOURCE_CORRUPT`。** `searchQuery.ts:105-118` 的 `try/catch` 只包住 SQL select；`rows.slice(...).map(hit)` 在 `:119` 才执行。因此 `hit()` 中的 item JSON decode、deleted/pending/role/target/identity 校验（`:60-71`）均会泄漏普通 `Error`/`RangeError`，与 SQL 阶段损坏在 `:116-118` 得到 typed source-corrupt 的语义不一致。这正好遗漏了用户指定的 raw-hit decode/identity corruption 路径。最小修复：将 select 与全部 row→hit/key decode 放入同一分类边界，保留已有 `AgentHistoryError`，其余 canonical/raw-hit 损坏统一包装为 `AGENT_HISTORY_SOURCE_CORRUPT`；补真实 SQLite 的坏 `item_json`、坏 target、坏 identity 测试。

2. **派生 FTS/index-state 故障与 canonical source 损坏被错误混为一类，且 schema mismatch 没有按合同 drop/rebuild。** facade 在 `searchIndex.ts:19-22` 把 reconciler 中所有非 typed 异常都包成“canonical events cannot be indexed”；这同时包括 FTS `DELETE/INSERT`、state upsert/select 失败（`searchReconciler.ts:23-29,52-67,72-75`），所以可丢弃的 FTS shadow/content/state 损坏会被误报为原始证据损坏。另外 version mismatch 只 `DELETE` 两张表（`:26-29`），没有 drop/recreate；表结构或 shadow 损坏时 DELETE 本身就可失败。`ensureAgentHistorySearchSchema()` 仅用 COUNT 探测（`searchSchema.ts:13-20`），也不能证明 FTS 的 MATCH/insert/delete 状态可用。最小修复：分开 canonical decode/sequence 与 derived-index SQL 错误；后者仅 drop/recreate `AGENT_HISTORY_SEARCH_TABLES` 并有界重建，重建仍失败才返回 `SEARCH_INDEX_UNAVAILABLE`；version mismatch 走同一 drop/rebuild 路径。补 shadow table 破坏、错 schema/state 列、MATCH 失败的真 SQLite 分类测试。

3. **FTS hit 没有证明与 canonical item 的身份/排序字段一致，可静默错序。** query 同时取 FTS 的 `history_id/item_id/role/item_ordinal/created_at` 与 canonical `item_json`（`searchQuery.ts:107-114`），但 `hit()` 只对 decoded role 与 FTS role 做等值校验（`:63-65`）；它把 FTS ordinal/createdAt 直接当作权威值（`:66-71`），完全没选 canonical `i.item_ordinal/i.created_at`，也没校验 catalog history identity。修改 FTS 这些 UNINDEXED 列就能在不报错的情况下改变 keyset 顺序和返回元数据。最小修复：SELECT canonical ordinal/createdAt/history identity，严格校验 FTS identity、ordinal、createdAt、role 全部与 canonical row/decoded item 一致，不一致走 finding 1 的 typed corruption；补逐列篡改测试。

4. **search cursor 不是严格 canonical codec。** `searchCursor.ts:50-61` 只检查顶层/filters/snapshot/key 的直接 keys，却不检查 `filters.target` 的精确 shape；运行时带额外 key、空 identity 或 root 带 child 字段的 target 可被 `normalizeSearchFilters()` 原样编码（`:27-35`）并通过回解。snapshot 也只做与当前值的等值比较（`:55-57`），key 的 updatedAt/itemOrdinal 仅要 finite（`:59-61`），因而接受负数、小数和非 safe integer；historyId/itemId 也允许空字符串。最小修复：复用/提取严格 target runtime codec；对 snapshot 要求 non-negative safe integers，rank 要求 finite，updatedAt/itemOrdinal 要求 non-negative safe integers，identity 要求 non-empty，并添加递归 exact-key 反例。

## Minor

1. `searchQuery.ts:130` 硬编码 `100_000`，没有使用 020 公开的 page-output limit 常量。当前数值相同，但合同变更会静默漂移。最小修复：导入并使用公共常量，以完整 result envelope 继续计量。

## 其余审核结论

- FTS5 compile option 与真建表探测、安全参数化 MATCH、Unicode code-point query/snippet 上限、global/target/roles/deleted 主路径、rank 全 keyset、event/history 总 cap、mutation 后 watermark、幂等重放、lag/unavailable 无 LIKE fallback 的正向实现均存在。
- drop helper 只列出本叶两张表（`searchSchema.ts:4-7,41-44`），不会主动 drop rollout 五表；但 schema-mismatch 自愈未消费该 helper，故不能签发 drop/rebuild 等价性。
- 已完整读取 index、050 task/report、020/030 当前合同与 review，以及 storage 两份 final review；只审查 050 owners。

## 亲自验证

- 定向 Vitest：5 files / 12 tests passed（真实 `node:sqlite` FTS5）。
- `pnpm exec tsc -b --pretty false`：passed。
- owners 行数全部 `<=300`；本 review 仅负责 050 复审结论，未修改产品、测试、task 或 index。

## R1 review

VERDICT: FAIL

严重度：Critical 0 / Important 2 / Minor 0

### 原 findings 关闭情况

- ✅ raw hit 的 item JSON、target、identity、deleted/pending/plan-stage 现在在 `searchQuery.ts:133-137` 的统一 decode 边界内；非 derived/typed 损坏被包为 `AGENT_HISTORY_SOURCE_CORRUPT`。真 SQLite 测试 `searchIndex.query.test.ts:122-139` 覆盖坏 JSON、target、identity 与 flag。
- ✅ FTS content/history/item/role/ordinal/createdAt 已与 canonical catalog/item/decoded item 逐列对拍（`searchQuery.ts:62-82,118-129`），mismatch 使用 derived marker 触发重建；真 SQLite 逐列篡改测试在 `searchIndex.query.test.ts:101-120` 通过。
- ✅ active probe 已实际执行 state upsert、FTS 七列 insert、MATCH 命中与两表 delete（`searchSchema.ts:25-42`）；错 state 列与真 shadow-table 破坏会只 drop/recreate 本叶表（`:45-67`）。schema-version mismatch 也改为 derived failure（`searchReconciler.ts:27-35`），由 facade rebuild。
- ✅ 混合 MATCH/JOIN SQL 失败会用 active probe 区分：probe 健康则 canonical source-corrupt，probe 失败才进 derived rebuild（`searchIndex.ts:45-51`）；typed canonical error 不会被 derived warning 吞掉。
- ✅ cursor 现在递归 exact 校验 root/child target 与非空 identity（`searchCursor.ts:20-43`），snapshot/updatedAt/itemOrdinal 要求非负 safe integer，rank 要求 finite（`:44-47,77-88`）；反例测试在 `searchCursor.test.ts:29-47` 通过。
- ✅ page budget 已改用公共 `AGENT_HISTORY_PAGE_MAX_CHARS`（`searchQuery.ts:1-4,149-150`）。

### Important

1. **derived search-state 的值损坏仍被误分为 canonical source corruption，未达到 state mismatch 只自愈/不 source-corrupt。** active probe 只验证探针 history 的列可写可删（`searchSchema.ts:26-42`），不校验已有 state rows。例如将某个 `indexed_rollout_ordinal` 改为 `-2`、小数或 TEXT，`ensureAgentHistorySearchSchema()` 仍成功；随后 `searchReconciler.ts:36-44` 的 mixed catalog/state SELECT 取出该值，`integer()` 抛普通 `Error`，facade 在 `searchIndex.ts:29-34` 将其包成 `AGENT_HISTORY_SOURCE_CORRUPT`。同样，`:36-40` 这条 mixed SELECT 本身若因 state 在 ensure 之后损坏，也会落入 source-corrupt，而不是 derived rebuild。最小修复：将 state row decode/合法性验证明确包装为 `DerivedSearchIndexError`；mixed SELECT 失败使用与 query 相同的 active-probe 归因，不得默认 canonical。补真 SQLite 的负 watermark/非整数/错类型与 ensure→reconcile 故障窗口测试，证明只 drop/recreate 本叶表并有界重建。

2. **有 next cursor 时，canonical sort-key decode 仍在 raw-row typed catch 之外，可泄漏普通错误。** `hit()` 验证了 rank 但没验证 canonical `c.updated_at`（`searchQuery.ts:62-82`）；`makeResult()` 在 `:140-147` 才从 raw row 调用 `integer(lastRow.updated_at, ...)` 组 cursor，这一路径不在 `:133-137` 的 source-corrupt catch 内。当页面有 lookahead/输出截断而 catalog `updated_at` 为 NULL、TEXT、小数或负数时，搜索会直接泄漏普通 `Error`；单命中无 cursor 时又可静默返回坏 catalog timestamp。最小修复：在 row→hit decode 中一次验证并保留 canonical updatedAt/rank/full key，cursor 只消费已验证的 key；补单命中与分页两种真 SQLite 反例，均应稳定返回 `AGENT_HISTORY_SOURCE_CORRUPT`。

### R1 亲自验证

- 定向 Vitest：5 files / 17 tests passed（包含真实 `node:sqlite` FTS5/shadow-table 故障）。
- `pnpm exec tsc -b --pretty false`：passed。
- R1 owners 均 `<=300`；只在本报告追加 review，未修改产品、测试、task 或 index。

## R2 review

VERDICT: PASS

严重度：Critical 0 / Important 0 / Minor 0

- ✅ R1 Important 1 已关闭。schema mismatch count、per-history indexed watermark、lag count 与 watermark sum 现在全部使用 derived decode（`searchReconciler.ts:16-19,31-39,51-55,87-95`）；负数、小数、TEXT 与非 safe integer 不再落入 canonical source-corrupt。真 SQLite/controlled-executor 测试 `searchIndex.reconcile.test.ts:75-82,107-123` 覆盖坏 watermark 与 count/sum decode，均只重建 derived 表并从 canonical events 有界恢复。
- ✅ mixed catalog/state history SELECT 与 lag-summary SQL 失败均改为 `MixedSearchIndexSqlError`（`searchReconciler.ts:40-49,87-93`）。facade 首次与 retry 分支都执行 active probe：probe 失败才视为 derived 并 drop/recreate，probe 健康则 fail-closed source-corrupt（`searchIndex.ts:28-48`）。ensure→history/lag 两个 state-drop 竞态已由 `searchIndex.reconcile.test.ts:84-99` 真 SQLite 覆盖。
- ✅ canonical 值不会被 derived 降级。mixed row 中 `history_id` 和 `last_rollout_ordinal` 仍由 canonical validator 检查（`searchReconciler.ts:51-54`）；非法 catalog ordinal 在 `searchIndex.reconcile.test.ts:101-105` 稳定返回 `AGENT_HISTORY_SOURCE_CORRUPT`。event sequence/JSON/identity 继续走 canonical fail-closed（`searchReconciler.ts:57-66`）。
- ✅ R1 Important 2 已关闭。每个返回 row 在 `decodeRow()` 中一次生成 `{ hit, key }`，rank、canonical `updated_at`、history/item identity、ordinal 与其余 hit 字段在同一 typed boundary 内校验（`searchQuery.ts:65-89,139-143`）。cursor 与输出预算只消费 decoded key/hit，不再读 raw row（`:144-154`）。单命中与分页的坏 updatedAt 均由 `searchIndex.query.test.ts:142-157` 证明 typed source-corrupt。
- ✅ 自愈边界是有限的：`reconcile()` 只有初次与一个显式 retry 分支（`searchIndex.ts:28-49`），retry 内不递归调用自身；重复 derived 失败返回 unavailable。drop helper 仍只包含 `agent_history_search_fts` 与 `agent_history_search_state`（`searchSchema.ts:5-9,63-67`），没有 rollout 五表或 source 写路径。
- ✅ 本人复跑定向 Vitest：5 files / 28 tests passed（真实 `node:sqlite`）；`pnpm exec tsc -b --pretty false` 与 owner `git diff --check` 通过。R2 owners 全部 `<=300`，未发现新回归。
