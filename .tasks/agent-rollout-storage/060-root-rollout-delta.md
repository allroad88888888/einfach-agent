---
id: "060"
title: 计算 root recovery 增量
kind: leaf
parent: "3000"
depends_on: ["010"]
discovered_from: null
model: gpt-5.6-terra
status: done
repair_round: 1
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/agent-core/src/history/rootRolloutDelta.ts
  - packages/agent-core/src/history/rootRolloutDelta.test.ts
---

# 计算 root recovery 增量

## 目标

实现纯函数，把前后两个 `RecoverySnapshotV1` 的 root 会话差异转换为确定的 rollout mutation batch。

## 接口

`buildRootRolloutDelta(previous, current)` 不读取 atom、文件或时钟。首次 current 产生 session meta、全部
item upsert、turn/run state；后续只产生实际变化。比较语义必须覆盖：

`previous` 存在但 `sessionId` 与 current 不同时必须在产生任何 mutation 前抛出；会话切换由 coordinator
显式清空 previous，不能把旧会话删除错误写成新会话 tombstone。

- 新 item：按 current 顺序 upsert。
- 内容或 pending/plan stage 变化：同 item id 产生新 upsert。
- reorder：受影响 item 以新 `itemOrdinal` upsert。
- 缺失 item：产生 `item_deleted` tombstone，不靠投影自行猜测。
- session/run metadata：稳定序列化后有变化才发 mutation。

输出顺序固定为 meta/context、item mutation、run state，保证同输入 byte-for-byte 相同。

## 验收标准

1. 空→已有 snapshot 能完整回填；相同 snapshot → 空 batch。
2. append、update、reorder、delete、pending finalization 各有独立用例。
3. 输入对象不被修改，测试固定输出顺序并覆盖 Unicode/tool item。
4. `pnpm exec vitest run packages/agent-core/src/history/rootRolloutDelta.test.ts` → 通过。
5. 实现不超过 300 行，不依赖 runtime singleton 或 persistence driver。

## 禁止项

- 不写文件/SQLite，不在本叶接入 recovery writer。
- 不用 JSON stringify 整个 snapshot 作为单条 opaque mutation。
