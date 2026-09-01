# 030 执行报告

## 结果

- 新增严格、版本化的 base64url cursor codec；cursor 绑定 query kind、规范化 filters、snapshot 与 keyset，拒绝未知字段、错 query/filter，并区分 stale。
- 新增只依赖 `SqlExecutor` 的 canonical rollout query repository，实现 global/target history list、item list 与 Unicode code-point 分段 read。
- catalog target、时间、terminal 标记、最新 run status、item JSON/role/ordinal/pending 等均运行时严格校验；损坏统一 fail-closed 为 `AGENT_HISTORY_SOURCE_CORRUPT`。
- history 分页按 `updated_at DESC, history_id ASC`，snapshot 使用全局 events count；item 分页按 `item_ordinal, item_id`，snapshot 使用 target `last_rollout_ordinal`。
- 默认排除 tombstone，read 区分 deleted/not-found；preview、稳定 JSON、1 MiB JSON decode 上限及 20,000 code-point read 上限复用 020 helpers。
- page 超过 100,000 字符预算时返回 `OUTPUT_TRUNCATED` 与 continuation cursor。

## 验证

- `pnpm exec vitest run packages/host-node/src/rollout/queryCursor.test.ts packages/host-node/src/rollout/queryRepository.test.ts packages/host-node/src/rollout/projector.test.ts`：PASS，3 files / 13 tests。
- `pnpm exec tsc -b`：PASS。
- `pnpm check:boundaries`：PASS（仅既有豁免观察项）。
- `pnpm check:state`：PASS。
- `git diff --check`：PASS。
- owner 行数：117 / 39 / 198 / 115，全部 `<=300`。

## 边界

- 仅新增任务 frontmatter 指定的四个产品/测试 owner 文件，并写本报告。
- 未修改 projector、projection schema、JSONL、legacy、FTS、HTTP 或 task/index；未 commit，未 reset/checkout。

## R1 修复

- item cursor exact schema 新增排序去重后的 `roles`，nullable `itemOrdinal` keyset 与规范 base64url 校验；换 role/target/delete filter 均拒绝 cursor。
- items 按 100 行有界 SQL 批次解码后过滤角色，可跨批次及跨页稳定取多角色结果。
- 支持 projector 的合法 delete-before-upsert NULL tombstone：返回 `materialized:false`；delete-after-upsert 保持 `materialized:true`；NULL ordinal 按 SQLite ASC + itemId 稳定续页。
- history summary 严格返回仅统计 `deleted=0` 的 `itemCount`；status、complete、identity 与 item state 损坏继续 fail-closed。
- 新增单一职责 `queryPageBudget.ts`，按完整最终 envelope（wrapper、warning、cursor、标点）逐候选测量；正常预算截断必有 cursor，首项/identity/cursor 本身无法容纳时抛有界 `RangeError`。
- read 复用一次 item decode，deleted unknown/materialized item 都返回 `AGENT_HISTORY_ITEM_DELETED`，成功结果固定为 materialized summary。
- 新增真实 projector→repository 测试，覆盖 unknown/materialized tombstone、NULL keyset、terminal status/complete 与 nondeleted itemCount。

## R1 验证

- 定向 Vitest（cursor、page budget、repository、projector integration、projector）：PASS，5 files / 21 tests。
- `pnpm exec tsc -b`、`pnpm check:boundaries`、`pnpm check:state`、`git diff --check`：全部 PASS。
- 七个 owner 行数：126 / 51 / 32 / 20 / 213 / 166 / 63，全部 `<=300`。

## R2 修复

- role-filter scan 增加每请求累计 200 行 hard cap；单条 SQL 仍最多 100 行，且 cap 大于最大逻辑页所需的 `pageLimit+1=101`。
- scan 结果显式携带 `scannedKey`、`exhausted` 与 `capReached`。
- cap 内存在未返回 matched 候选时，cursor 始终锚定最后实际返回项，避免跳项。
- cap 内所有 matched 候选均已返回时，cursor 锚定最后扫描项并返回明确的 `OUTPUT_TRUNCATED` bounded-scan warning；零匹配也返回可前进的空页 cursor。
- 空 bounded-scan 页同样通过完整最终 envelope 的 100,000 字符预算检查。
- 新增超过 cap 后才匹配的空页→匹配页测试，以及 cap 内已返回匹配项使用扫描 watermark 后无重复遗漏的测试。

## R2 验证

- 定向 Vitest（cursor、page budget、repository、projector integration、projector）：PASS，5 files / 23 tests。
- `pnpm exec tsc -b`、`pnpm check:boundaries`、`pnpm check:state`、`git diff --check`：全部 PASS。
- 七个 owner 行数：126 / 51 / 32 / 20 / 228 / 199 / 63，全部 `<=300`。
