# 020 独立复审

VERDICT: FAIL

严重度：Critical 0 / Important 1 / Minor 1

## 逐项结论

- ✅ 公共 DTO 与四方法 capability 齐全：`historyQuery.ts:73-124` 定义四组 input/result，`historyQuery.ts:126-135` 定义 capability 与 provider；公开查询 input 均没有 workspace/source path，locator 只出现在 provider context（`historyQuery.ts:133-135`）。
- ✅ limits 合同齐全：list 20/100、search 20/50、preview 2,000、read 20,000、query/snippet 1,000、page 100,000 均在 `historyQuery.ts:3-12` 固化。
- ✅ status 与 complete 是独立字段，且 legacy 可表达：`historyQuery.ts:15-18` 包含 canonical 状态与 `legacy`，`historyQuery.ts:45-53` 独立暴露 `status`/`complete`。合同层没有错误地把 `complete:false` 与 partial warning 绑定。
- ✅ warnings/errors 至少覆盖任务要求：warning union 见 `historyQuery.ts:21-24`，error union 见 `historyQuery.ts:30-34`；稳定带码错误类见 `historyQuery.ts:36-43`。
- ✅ ModelItem 的 role、搜索文本、preview、read JSON 文本职责已分离并公开：`historyItemText.ts:80-103`；read 以 code-point offset 返回 chunk/nextOffset/totalChars（`historyItemText.ts:105-133`），没有使用 `[...text]`/`Array.from(text)` 展开全文。
- ❌ **Important — 字节上限检查会在拒绝之前按整个不可信输入分配内存。** `decodeAgentHistoryModelItem` 在 `historyItemText.ts:70-73` 调用 `encoder.encode(json)`，`TextEncoder.encode` 会先创建与完整 UTF-8 输出同量级的 `Uint8Array`，再读取 `byteLength`。因此一个远超 1 MiB 的 JSON 字符串仍会触发无界的额外分配，违反“单 item decode 独立字节上限 / 字符上限不能掩盖无界内存分配”的合同。应以无整体输出分配的有界 UTF-8 计数（达到上限立即停止）或固定大小 `encodeInto` 缓冲实现。现有测试 `historyItemText.test.ts:38-41` 只证明最终抛错，没有证明拒绝前内存有界。
- ⚠️ **Minor — Unicode 扫描把任意高代理项后的 code unit 都当作代理对。** preview 的 `historyItemText.ts:40-43` 与 read 的 `historyItemText.ts:120-123` 只检查首项为 high surrogate 和后面仍有字符，没有检查后一项是否为 low surrogate。对合法配对 emoji 的主路径正确，但对含未配对 high surrogate 的 JS 字符串会错误合并下一个字符，造成 offset/limit/totalChars 偏差；`historyItemText.test.ts:32-35` 仅覆盖合法代理对。应同时校验后一 code unit 在 `0xDC00..0xDFFF`。
- ✅ 公共导出边界正确：`history/index.ts:2-3` 从 `@einfach-agent/core/history` barrel 导出本叶公共面；package subpath 已存在，且本叶没有修改 root barrel。
- ✅ 文件职责与行数符合硬规则：owner 文件分别为 135、61、134、43、24 行，全部 `<=300`；两个实现文件分别聚焦查询合同与 item 文本转换，没有假拆分或大杂烩。
- ✅ 范围合规：相对 frontmatter base，本叶 owner 在基线中不存在，当前新增内容只落在列出的五个 owner；未发现 SQLite、文件 IO、FTS、ToolContext、权限或 workspace identity 实现。

## 复审说明

本结论来自 owner 实现逐行审查与针对代理项的最小反例分析，没有用执行报告中重复的测试运行替代代码审查。任务所述 `../agent-rollout-storage` 路径在当前工作区不存在，因此无法读取该路径下 final reviews；现有 owner 均为相对 base 的新增文件，不影响上述增量归属判断。

## R1 correction

VERDICT: PASS

严重度：Critical 0 / Important 0 / Minor 0

- ✅ 原 Important 已关闭。`historyItemText.ts:22-32` 的 `boundedUtf8ByteCount` 逐个 code point 累加 UTF-8 字节数，并在 `bytes > maxBytes` 后立即停止；实现只维护数值计数器，不调用 `TextEncoder.encode`，也不创建随完整不可信输入增长的第二份 buffer。`decodeAgentHistoryModelItem` 在 `historyItemText.ts:91-98` 先走该有界检查，只有未越限才进入 `JSON.parse`。
- ✅ 新测试证明越限路径是早停而非扫描完整输入：`historyItemText.test.ts:44-49` 对超限 ASCII JSON 断言 `bytes === max + 1` 且 `codeUnitsRead < oversized.length`，同时验证公开 decoder 拒绝；`historyItemText.test.ts:53-57` 覆盖 ASCII、2-byte、3-byte、合法代理对 4-byte 与未配对代理项 3-byte 的计数。测试无法直接证明“零分配”，但产品代码 `historyItemText.ts:22-32` 没有任何 buffer/数组/substring 构造，静态证据与早停断言共同证明所要求的有界路径。
- ✅ 原 Minor 已关闭。共享的 `codePointWidthAt` 在 `historyItemText.ts:16-20` 同时要求 high surrogate `0xD800..0xDBFF` 与紧随的 low surrogate `0xDC00..0xDFFF` 才返回宽度 2；preview 与 read 分别在 `historyItemText.ts:58-67`、`:133-153` 复用该逻辑。
- ✅ 未配对反例已有覆盖：`historyItemText.test.ts:37-41` 验证 high surrogate 后接普通字符时 read 将其计为独立 code point，且 preview 不吞掉后续字符；合法 emoji 配对仍由 `historyItemText.test.ts:33-36` 覆盖。
- ✅ 本人最小复跑 `pnpm exec vitest run packages/agent-core/src/history/historyItemText.test.ts`：1 file / 4 tests passed。
- ✅ 更正上轮路径说明：rollout sibling 实际位于 `.tasks/agent-rollout-storage`，其 `final-review.md` 与 `final-review-2.md` 均为 PASS；上轮“`../agent-rollout-storage` 不存在”是路径识别错误，不影响 020 产品 verdict。R1 未引入新的 Critical、Important 或 Minor。

## R2 review

VERDICT: FAIL

严重度：Critical 0 / Important 1 / Minor 0

- ✅ roles filter 合同已补齐：`historyQuery.ts:95-102` 在 list-items input 增加 `roles?: readonly AgentHistoryItemRole[]`，并明确 provider 必须在 cursor binding 前排序、去重；它与 search 的独立 roles filter（`:125-131`）没有混淆。
- ✅ `itemCount` 是 required 且语义准确：`historyQuery.ts:45-55` 将其定义为 materialized、non-deleted item count；root/child/running/terminal/legacy 的类型样例都必须提供该字段（`historyQuery.test.ts:36-45`）。
- ✅ delete-before-upsert 没有伪造 ordinal、timestamp、role 或内容：`historyQuery.ts:57-69` 允许前三者为 `null`，preview 为空字符串；测试用例 `historyQuery.test.ts:51-63` 精确表示 unknown tombstone。该表示与真实投影一致：`projectionSchema.ts:37-41` 的 ordinal/created/item JSON/plan stage 可 NULL，delete-only INSERT 只写 identity/delete metadata（`projector.ts:118-126`）；`pending:false` 来自 schema 的非空默认值而非虚构 payload 内容。
- ✅ read/search 的 materialized 非空约束生效：`MaterializedAgentHistoryItemSummary` 在 `historyQuery.ts:71-75` 将 ordinal/createdAt/role 收窄为非 null，search hit（`:77-81`）与 read result（`:116-123`）均直接使用它，因此 unknown tombstone 不能静态进入这两个结果。
- ❌ **Important — list item 合同不能按 tombstone/materialized 分支收窄整个对象。** `AgentHistoryItemSummary` 仍是一个所有对象都携带 `number | null` / `role | null` 的单接口（`historyQuery.ts:57-69`），而 `ListAgentHistoryItemsResult.items` 直接返回该接口数组（`:103-108`）。即使 consumer 检查 `deleted`，该字段只是普通 `boolean`，不会收窄 nullable 元数据；即使逐项检查 `itemOrdinal !== null`，TypeScript 也只收窄该属性读取，不会把对象变成 `MaterializedAgentHistoryItemSummary`，其余 `createdAt`/`role` 仍需重复检查，也不能把对象传给 read/search 共用的 materialized consumer。任务要求的“list consumer 可分支”因此没有形成类型合同。应把 list summary 建模为 union，例如 `MaterializedAgentHistoryItemSummary | UnknownAgentHistoryItemTombstoneSummary`，后者用稳定判别字段（可用 `itemOrdinal:null` 或显式 kind）并固定 `deleted:true`、`createdAt:null`、`role:null`、`preview:''`；测试应以控制流/`expectTypeOf` 证明两个分支分别收窄，而不只是构造一个运行时对象。注意 materialized item 也可能 `deleted:true`，所以不能仅以 `deleted` 作为两类唯一判别。
- ✅ 公共导出保持正确：`history/index.ts:2-3` 的 history subpath wildcard 导出新增接口，root barrel 未增加；R2 没有新增路径或越界实现。
- ✅ owner 行数为 147 / 84 / 154 / 58 / 24，全部 `<=300`，职责仍分别聚焦查询合同、item 文本与各自测试。
- ✅ 本人复跑三项 core 定向测试：3 files / 21 tests passed；`pnpm check:boundaries` 与 owner `git diff --check` 通过。
- ✅ 当前 `tsc -b` 失败只由新合同触发的下游未适配构成：030/040 缺 required `itemCount`，其 search/read/list 返回仍携带 nullable 通用 summary；错误均落在 `legacyChildHistory.ts`、`legacyRootHistory.ts`、`queryRepository.ts`，未发现 020 owner 自身类型错误。按任务说明这不是额外 verdict 问题，但也从侧面证明 materialized 收窄已约束 read/search；它不能弥补上述 list union 缺口。

## R3 review

VERDICT: PASS

严重度：Critical 0 / Important 0 / Minor 0

- ✅ R2 Important 已关闭。`historyQuery.ts:65-86` 现在公开 `MaterializedAgentHistoryItemSummary | UnknownAgentHistoryItemTombstoneSummary` 判别 union，并以字面量 `materialized:true/false` 作为稳定判别字段；`ListAgentHistoryItemsResult.items` 在 `:114-119` 返回该 union。
- ✅ materialized item 允许 `deleted:true`：公共 materialized 分支继承的 `deleted` 仍为 boolean（`historyQuery.ts:57-71`），测试 `historyQuery.test.ts:77-81` 明确构造已删除但仍有历史 payload/排序元数据的 materialized item，因此没有把 `deleted` 错当成 unknown tombstone 判别。
- ✅ unknown tombstone 的无证据字段固定：`historyQuery.ts:73-82` 将 ordinal/createdAt/role 固定为 `null`、preview 固定为 `''`，并固定 `pending:false`、`planStageId:null`、`deleted:true`；不能伪造为 materialized 内容。
- ✅ 一次判别可收窄整个对象：`historyQuery.test.ts:68-89` 仅检查一次 `item.materialized`，随后两支分别由 `expectTypeOf` 精确等于完整 materialized/unknown 接口，并直接安全读取各分支字段。该测试同时执行 known-deleted 与 unknown 两条路径。
- ✅ read/search 继续只接受 materialized：`ReadAgentHistoryItemResult.item` 在 `historyQuery.ts:127-134` 仍为 `MaterializedAgentHistoryItemSummary`，`AgentHistorySearchHit` 在 `:88-92` 仍继承同一 materialized 接口，R3 未放宽非空保证。
- ✅ 未发现 R3 新问题：公共 history barrel 的 wildcard 会导出两个公开分支与 union；实现/测试分别 158/110 行，其余 owner 154/58/24 行，均 `<=300`。
- ✅ 本人复跑 core 定向测试：3 files / 22 tests passed；owner `git diff --check` 通过。
