---
id: "020"
title: 定义历史查询合同
kind: leaf
parent: "1000"
depends_on: []
discovered_from: null
model: gpt-5.6-sol
status: done
repair_round: 3
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/agent-core/src/history/historyQuery.ts
  - packages/agent-core/src/history/historyQuery.test.ts
  - packages/agent-core/src/history/historyItemText.ts
  - packages/agent-core/src/history/historyItemText.test.ts
  - packages/agent-core/src/history/index.ts
---

# 定义历史查询合同

## 目标

定义四方法历史 capability 的 transport-neutral 类型、限制与稳定错误语义。

## 产出

`historyQuery.ts` 复用现有 `AgentHistoryTarget`，导出：

- `AgentHistoryCapability` 与 `AgentHistoryCapabilityProvider.forContext({legacyWorkspaceRoot?})`。
- 四组 input/result、summary/item/search-hit、opaque cursor、warning、status、error code 类型。
- 统一限制常量：list 20/100、search 20/50、preview 2,000、read 20,000、query 1,000、page 100,000。
- `complete` 与 `status` 分离：canonical running 可 false 且无 partial warning；terminal true；legacy 固定 false。
- warning 至少含 `LEGACY_PARTIAL_HISTORY`、`MALFORMED_LEGACY_RECORD`、`PROJECTION_LAG`、
  `SEARCH_INDEX_LAG`、`SEARCH_INDEX_UNAVAILABLE`、`OUTPUT_TRUNCATED`。
- error code 至少含 unavailable、invalid/stale cursor、history/item not found、item deleted、source corrupt。

`historyItemText.ts` 只负责把合法 `ModelItem` 提取成 role、可搜索文本、preview 与可分段读取的稳定 JSON 文本。
Unicode offset 以 code point 计，不能切断 surrogate pair；实现不能用无界 `[...hugeText]` 分配。ModelItem JSON decode
必须有独立字节上限。

cursor 仍是 opaque string；具体铸造与 keyset 由 030 实现。`legacyWorkspaceRoot` 只在 provider 内部绑定，四个公开
tool input 不含任何路径。

## 验收

1. 类型测试覆盖 root/child target、running/terminal/legacy、四组结果和全部限制。
2. item text 测试覆盖 user/assistant/tool、tool_calls、Unicode code-point chunk、超大 JSON 拒绝。
3. `@einfach-agent/core/history` 公共导出可用，root barrel 不增加。
4. `pnpm exec vitest run packages/agent-core/src/history/historyQuery.test.ts packages/agent-core/src/history/historyItemText.test.ts packages/agent-core/src/history/rolloutRecordCodec.test.ts` 通过。
5. `pnpm exec tsc -b`、`pnpm check:boundaries` 与 owner `wc -l <=300` 通过。

## 禁止项

- 不实现 SQLite、文件、FTS、ToolContext 或权限。
- 不新增 workspace identity，不接受 archive/source path。
