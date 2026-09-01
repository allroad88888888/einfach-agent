# 020 执行报告

状态：DONE

修复轮次：R1

## 交付

- 新增 transport-neutral 历史查询合同：四方法 capability/provider、四组输入结果、summary/item/search hit、opaque cursor、warning、status 与稳定 error code。
- 固化 list/search/read/preview/query/snippet/page 的默认值与上限常量；公开输入不含 workspace/source path，legacy workspace root 仅存在于 provider context。
- 新增 ModelItem 文本职责模块：有界 JSON decode、role/search text/preview/stable JSON，以及按 Unicode code point 分段读取；实现逐 UTF-16 code unit 扫描，不用展开整个字符串。
- R1 将 `TextEncoder.encode` 整份分配替换为提前停止的 UTF-8 byte 计数；公开计数结果中的 `codeUnitsRead` 作为测试 seam，证明超限输入未被完整扫描或编码。
- R1 统一使用严格 surrogate-pair 宽度判断；只有 high surrogate 紧跟 low surrogate 才算一个 code point，未配对代理项按单 code unit 处理。
- 仅从 `@einfach-agent/core/history` barrel 导出新增公共面，未修改 root barrel。
- 新增合同与文本单元测试，覆盖 root/child、running/terminal/legacy、四方法、限制、user/assistant/tool、tool calls、合法/未配对 surrogate 与超大 JSON 提前拒绝。

## 验证

- `pnpm exec vitest run packages/agent-core/src/history/historyQuery.test.ts packages/agent-core/src/history/historyItemText.test.ts packages/agent-core/src/history/rolloutRecordCodec.test.ts`：R1 通过，3 files / 19 tests。
- `pnpm exec tsc -b`：通过。
- `pnpm check:boundaries`：通过；仅输出仓库既有豁免观察项。
- `git diff --check -- packages/agent-core/src/history`：通过。
- owner `wc -l`：historyQuery 135、其测试 61、historyItemText 154、其测试 58、history index 24，全部 <=300。

## 裁决

- `AgentHistoryStatus` 保留 rollout 的全部运行态并增加 `legacy`，同时独立暴露 `complete`。理由：下游可无损映射 canonical 状态，且不会把 running 的 incomplete 误判为 partial warning；错了的代价是 UI 需要决定哪些细粒度等待态合并展示。
- read 返回稳定 JSON 文本，而搜索文本只拼接用户文本、assistant 内容/推理/tool call 与 tool result。理由：read 需要可重现完整 item，FTS 则需要降低结构噪音；错了的代价是图片只按 name/mimeType 可搜索。

## 关注项

无。

## R2：跨查询合同补齐

状态：DONE（020 owners）；等待 030/040 消费方适配。

- `ListAgentHistoryItemsInput.roles` 明确定义为 provider 在 cursor 绑定前排序去重的 role filter。
- `AgentHistorySummary.itemCount` 明确定义为 materialized、非删除 item 数量。
- `AgentHistoryItemSummary` 允许 delete-before-upsert tombstone 用 `itemOrdinal:null`、`createdAt:null`、
  `role:null`、`preview:''` 表示未知内容，不伪造排序或内容元数据。
- 新增 `MaterializedAgentHistoryItemSummary`，把 ordinal/createdAt/role 收窄为非 null；search hit 与 read result
  使用该类型，防止不可搜索的 unknown tombstone 混入。
- 合同测试新增 roles filter、itemCount、unknown tombstone 与 search-hit 非空收窄覆盖。

### R2 验证

- 定向 Vitest：通过，3 files / 21 tests。
- `pnpm check:boundaries`：通过，仅有仓库既有豁免观察项。
- owner `git diff --check`：通过。
- owner `wc -l`：147 / 84 / 154 / 58 / 24，全部 <=300。
- `pnpm exec tsc -b`：020 类型本身通过，下游未适配而失败，未越界修复：
  - `legacyChildHistory.ts:92`、`legacyRootHistory.ts:80`、`queryRepository.ts:71` 缺少新增 `itemCount`。
  - legacy child/root search 返回通用 nullable summary，尚未收窄为 materialized search hit。
  - `queryRepository.ts:180,183` 对 list/read 的 nullable tombstone summary 尚未分支收窄。

裁决：使用 nullable tombstone 元数据而非哨兵 ordinal/timestamp。理由是 projector 的 NULL 表示“从未有
upsert 证据”，公共合同保留这一事实可让 030 显式定义 NULL keyset 顺序；错了的代价是 list consumer 必须先按
`deleted`/nullable 字段分支，不能假定所有 summary 都可读取或搜索。

## R3：可判别 item summary

状态：DONE（020 owners）；等待 030/040 消费方适配。

- `AgentHistoryItemSummary` 改为真正的 discriminated union，以 `materialized` 为独立判别字段。
- `MaterializedAgentHistoryItemSummary` 固定 `materialized:true`，ordinal/createdAt/role 非 null；其
  `deleted` 仍为 boolean，因此明确允许“曾 upsert 后删除”的 materialized tombstone。
- `UnknownAgentHistoryItemTombstoneSummary` 固定 `materialized:false`、`deleted:true`、null metadata、
  `preview:''`、`pending:false` 与 `planStageId:null`，不伪造 delete-before-upsert 的内容。
- read/search 继续只返回 materialized summary。
- 新增控制流测试：一次检查 `item.materialized` 后，两侧分别由 `expectTypeOf` 证明整对象收窄为对应接口；
  同时以两个 deleted item 证明不能把 `deleted` 当作唯一判别。

### R3 验证

- 定向 Vitest：通过，3 files / 22 tests。
- `pnpm check:boundaries`：通过，仅有仓库既有豁免观察项。
- owner `git diff --check`：通过。
- owner `wc -l`：158 / 110 / 154 / 58 / 24，全部 <=300。
- `pnpm exec tsc -b`：下游 030/040 与其并行中的测试尚未适配而失败；与 R3 直接相关的诊断是
  `legacyRootHistory.ts:30` 不能再 interface-extend union，以及 `queryRepository.ts:84` 构造 materialized
  summary 时缺 `materialized:true`。其余 itemCount/search 收窄和缺失并行文件错误已存在于下游范围，本轮未越界修改。

裁决：采用显式 `materialized` discriminant，而不是以 `itemOrdinal:null` 隐式判别。理由是 consumer 一次分支即可
获得完整对象类型，且 `deleted` 可以正交表示两类 tombstone；错了的代价是所有 provider 必须在 DTO 构造处增加
一个布尔字段。
