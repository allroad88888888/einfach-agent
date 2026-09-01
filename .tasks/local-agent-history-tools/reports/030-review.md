# 030 独立复审

VERDICT: FAIL

## 结论

定向测试通过，但 030 尚未满足已裁决的 items 合同与合法五表状态：role filter 和 itemCount 在 020 公共合同中缺失；合法的 tombstone-only 投影会被查询层误报为 source corruption；输出预算算法也不能保证“截断时返回 cursor”，并且没有按最终序列化结果实施 100,000 字符上限。

## Findings

### Critical

无。

### Important

1. **020/030 没有实现 list-items 的 role filter，cursor 因而也未与 role filter 绑定。** `packages/agent-core/src/history/historyQuery.ts:85-90` 的 `ListAgentHistoryItemsInput` 只有 target/cursor/limit/includeDeleted；`packages/host-node/src/rollout/queryCursor.ts:14-17,65-69` 的 item filters 同样没有 roles；`packages/host-node/src/rollout/queryRepository.ts:163-175` 查询所有匹配 tombstone 条件的行后直接分页。任务树公共合同要求 items role filter，030 叶也明确要求“role filter 在有界 SQL/codec 后生效”，所以这是跨 020 依赖的合同缺口，而不只是少一条测试。最小修复：在 020 为 `ListAgentHistoryItemsInput` 增加规范化的 `roles?: readonly AgentHistoryItemRole[]`，把排序去重后的 roles 纳入 item cursor schema/严格 key 校验，并在 030 有界候选解码后过滤；补充换 role filter 后 cursor 被拒绝及多角色分页测试。

2. **合法的 tombstone-only 行无法被 `includeDeleted:true` 列出。** projector 对从未出现过的 item delete 会插入 `item_json/item_ordinal/created_at` 均为 NULL 的合法行（`packages/host-node/src/rollout/projector.ts:118-126`）；但 repository 对每一行先强制要求 string `item_json` 并解码（`packages/host-node/src/rollout/queryRepository.ts:76-89`），而 `listItems` 在 includeDeleted 时会把该行送入该函数（同文件 `:169-175`），最终抛 `AGENT_HISTORY_SOURCE_CORRUPT`。删除未知 item 是 rollout mutation/projector 支持的正常状态，不能被当作源损坏；现有测试只删除先有 payload 的 item（`queryRepository.test.ts:56-65`），漏掉该真实 schema 状态。最小修复：先在 020 明确 tombstone summary 的可表示合同（例如 role/preview/createdAt/itemOrdinal 可空，或定义稳定的 tombstone 元数据），然后让 030 对 NULL tombstone 返回该表示；默认排除仍保持不变，并增加 delete-before-upsert 的真实 projector→repository 测试。

3. **输出预算不能保证截断后的可继续性，也没有约束最终返回对象。** `boundedPage` 只累计数组元素的 `JSON.stringify` 长度并硬留 2,000 字符（`queryRepository.ts:98-106`），未计入 history wrapper、warnings、JSON 标点和可能包含 target filters 的 base64 cursor。catalog 的 title/conversation/run/path 是无长度上限的真实 TEXT 字段，而 020 target 也只是裸 string（`packages/agent-core/src/history/agentHistoryTarget.ts:1-9`）。若首条 history summary 超过阈值，`bounded.values` 为空，`last` 不存在，返回空页且没有 nextCursor（`queryRepository.ts:155-161`），违反“截断时返回 cursor”；较大的 target filter 还可令 cursor 本身把最终页面推过 100,000 字符。最小修复：以完整候选结果（含 wrapper/warnings/cursor）计算最终序列化字符数；为首项过大定义可前进的截断/错误语义，不能返回无 cursor 的空截断页；补充超长 title/identity 与 cursor 开销测试。

4. **030 计算了 itemCount，但 020 合同无法承载，结果被静默丢弃。** SQL 正确计算 `deleted=0` 的 count（`queryRepository.ts:120-123`），`CatalogRow` 也声明 `item_count`（同文件 `:20-24`），但 `summary()` 不返回它（`:66-74`），因为 `AgentHistorySummary` 没有该字段（`packages/agent-core/src/history/historyQuery.ts:44-53`）。这未满足 030 明确的“itemCount 只算 deleted=0”，同时每页仍付出了相关子查询成本。最小修复：在 020 的 `AgentHistorySummary` 增加 `itemCount: number`，在 030 严格校验并返回 `item_count`，补充含 tombstone 的计数断言；若产品裁决确实不要该字段，则应先修改任务合同并删除无效子查询，而不是当前半实现状态。

### Minor

1. `readItem` 对同一 payload 解码两次：`itemSummary()` 已在 `queryRepository.ts:80-89` 解码，随后 `:191` 再次解码。对 1 MiB 上限附近的合法 JSON 造成不必要的 CPU/分配。最小修复：让内部解析函数同时返回 summary 与 decoded item，read 复用一次解析结果。

## 已验证

- 完整读取 030 index/task/report 以及前置 storage 的两份 final review。
- 对照读取五表 schema 与 projector 的真实 INSERT/UPDATE 字段。
- `pnpm exec vitest run packages/host-node/src/rollout/queryCursor.test.ts packages/host-node/src/rollout/queryRepository.test.ts packages/host-node/src/rollout/projector.test.ts`：3 files / 13 tests passed。
- owners 行数为 117 / 39 / 198 / 115，均不超过 300，职责边界未越入 projector/schema/legacy/FTS/HTTP。

## R1 review

VERDICT: FAIL

严重度：Critical 0 / Important 1 / Minor 0

### 原 findings 关闭情况

- ✅ 原 Important 1 的公共合同与 cursor 绑定部分已关闭。020 R3 在 `historyQuery.ts:106-113` 暴露 roles；030 在 `queryCursor.ts:16-20,69-75` 排序去重并校验 roles，在 `:107-114` 将其纳入严格 item cursor schema。换 roles/includeDeleted/target 会因 `assertRolloutCursor` 的完整规范 filters 比较（`:118-125`）被拒绝；snapshot 变化仍稳定返回 stale。现有跨 100-row SQL 批次和跨页测试证明稀疏匹配的正常路径。
- ✅ 原 Important 2 已关闭。`queryRepository.ts:78-99` 将真实 NULL delete-before-upsert 行表示为 `materialized:false`，同时保留 delete-after-upsert 的 decoded materialized summary；`itemAfter()` 在 `:118-124` 明确定义 SQLite ASC 下 NULL keyset 到 number keyset 的续页。真实 projector 测试 `queryRepository.projector.test.ts:29-61` 覆盖两个 unknown tombstone 按 itemId 排序后继续到 ordinal 7 的 materialized tombstone，并验证 terminal status/complete 与 itemCount。
- ✅ 原 Important 3 的输出 envelope 问题已关闭。`queryPageBudget.ts:9-24` 对 caller 构造的完整 result（含 wrapper、warnings、cursor）计量，至少保留一个可作为 continuation key 的候选，否则抛有界 `RangeError`；空结果 identity 也在 `:27-31` 单独计量。repository cursor 取最后一个实际返回项（`queryRepository.ts:177-181,192-197`），所以 page-limit 与 output-truncation 均不会跳项。超长首项、history identity 和含超长 target filter 的 cursor 开销已有测试并通过。
- ✅ 原 Important 4 已关闭。020 R3 将 `itemCount` 设为 required（`historyQuery.ts:45-55`）；030 SQL 只计 `deleted=0`（`queryRepository.ts:113-116`），并对结果做 non-negative safe integer 校验后返回（`:68-76`）。真实 projector delete-before/after-upsert 场景得到 0。
- ✅ 原 Minor 已关闭。`parsedItem()` 一次 decode 后同时返回 decoded item 与 summary（`queryRepository.ts:78-99`）；read 在 `:205-210` 复用 decoded item，没有第二次 JSON decode。

### 新发现

#### Important

1. **role-filter scan 仍是单次请求无界的，且没有 scan-cap 空页 continuation。** `ITEM_SCAN_BATCH=100` 只限制每条 SQL 的行数；`scanItems()` 在 `queryRepository.ts:138-157` 用 `while (matches.length < wanted && !exhausted)` 持续读取、解码下一批，直到收满匹配或扫完整个目标。若目标有百万条 system item 而请求 `roles:['user']`，一次同步 API 调用会执行约一万次 SQL，并逐条做最多 1 MiB JSON 的 decode/preview；“每批 100”不能满足任务要求的有界 SQL/codec。当前无匹配时 `listItems()` 在 `:189-191` 只有扫到真实 EOF 才返回空页，因此也没有“达到 scan cap 后返回带扫描 key 的空页 cursor”这一前进语义。最小修复：增加单请求总扫描行数/批次数上限；`scanItems` 返回最后扫描 key、是否 exhausted 与 matches。达到上限但无 match 时，允许返回 `items:[]`、`OUTPUT_TRUNCATED`（或专门的有界扫描 warning）及以最后扫描行 key 编码的 continuation cursor；有 match 时 cursor 必须根据最后已返回项或明确的扫描 watermark 设计，保证既不重扫无界前缀也不跳过未返回匹配。补充“超过总 cap 才出现首个目标 role”“一个 cap 内完全无匹配但后续有匹配”“NULL tombstone 跨 cap 进入 number ordinal”的分页测试。

#### Critical

无。

#### Minor

无。

### R1 亲自验证

- 定向 Vitest（cursor、page budget、repository、真实 projector integration、projector）：5 files / 21 tests passed。
- `pnpm exec tsc -b`：passed。
- `pnpm check:boundaries`：passed，仅输出既有豁免观察项。
- owners `git diff --check`：passed。
- 七个 owner 行数为 126 / 51 / 32 / 20 / 213 / 166 / 63，全部 `<=300`；新增 budget 模块职责单一，未越权修改 schema/projector/legacy/FTS/HTTP。

## R2 review

VERDICT: PASS

严重度：Critical 0 / Important 0 / Minor 0

- ✅ R1 新增 Important 已关闭。`queryRepository.ts:41-44` 将单 SQL batch 固定为 100、单请求累计扫描 hard cap 固定为 200；`scanItems()` 在 `:142-160` 同时以 `scanned < ITEM_SCAN_MAX_ROWS` 约束循环、以剩余额度收窄最后一条 SELECT，并且只在逐行 decode 后递增 scanned，因此每次 list-items 请求最多 SELECT/decode 200 个 item row，不再随历史总量增长。
- ✅ all-nonmatch cap 页可前进且预算完整。scan 返回 `scannedKey/exhausted/capReached`（`:142-160`）；零候选且达到 cap 时 `listItems()` 在 `:195-199` 返回空 items、bounded-scan `OUTPUT_TRUNCATED` warning 与 last-scanned cursor，并把包含 history、warning、cursor 的完整 envelope 交给 `assertEmptyQueryPageFits`。测试 `queryRepository.test.ts:93-109` 证明首个 user 位于 ordinal 201 时，第一页为空且有 warning/cursor、总 envelope `<=100000`，第二页准确返回该 user。
- ✅ cursor 不跳过未返回匹配。`unreturnedMatch` 由第 `pageLimit+1` 个 match 判定（`queryRepository.ts:192-194`）；只要存在未返回 match，`scanContinuation` 就为 false，builder 在 `:201-210` 以最后实际返回 item 为 key。只有 cap reached 且所有 match 已返回、同时没有 output-budget truncation 时才使用 last-scanned key；若预算再次截断，则仍使用 last-returned key。该分支组合保证扫描 watermark 不会越过尚未返回的匹配项。
- ✅ 第二页无重复遗漏。`itemAfter()` 对 cursor 使用严格 `>` keyset（`:121-127`）；测试 `queryRepository.test.ts:111-124` 在 cap 内 ordinal 50 已返回、ordinal 201 尚未扫描的场景证明第二页只返回 201，没有重复 50。NULL→number 的同一 keyset 规则仍由 R1 projector integration 覆盖。
- ✅ `pageLimit=100` 不会被 cap 误截断。repository 请求 `pageLimit+1` 个 matches（`:191-193`），最大为 101；hard cap 200 足够在前 101 行全匹配时收集 lookahead。循环会在第 101 个 match 停止，产生 `unreturnedMatch:true` 和正常 last-returned cursor，而不会触发 `capReached`。这是常量关系与循环条件的直接代码证据。
- ✅ 定向 Vitest（cursor、page budget、repository、真实 projector integration、projector）：5 files / 23 tests passed。未发现此次修复引入的新边界缺陷。
