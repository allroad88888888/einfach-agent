---
id: "055"
title: 为 legacy source 提供有界全局有序页
kind: group
parent: "2000"
depends_on: ["040"]
discovered_from: "060"
status: cancelled
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
---

# 为 legacy source 提供有界全局有序页

子叶：

- [056](056-legacy-ordered-scan-contract.md) 定义 ordered scan 状态合同。
- [057](057-legacy-child-ordered-pages.md) 接入 child filesystem traversal。
- [058](058-legacy-root-ordered-pages.md) 接入 root recovery SQLite scan。

## 发现原因

060 R1 证明现有 child continuation 只是 run/directory traversal 位置，且只在每个批次内部排序；后续批次
仍可能出现更大的 `updatedAt`/search key。service 在未完成有界扫描前无法安全发出全局第一页。root
`RecoveryDriver.listLatest()` 又是无 cursor 的全量 facade。仅在 060 外包 cursor 无法证明跨来源分页无重漏。

## 目标

为 legacy root/child 暴露 history-only、只读、有界、可续的 source query envelope，明确区分：

- `scan`：尚在遍历 source，此时不能把批内局部 top-K 当作全局 page 发出；
- `values`：已证明位于 `after` 之后的全局 next values；
- `snapshot`：绑定 index/directory/recovery generation/content；变化时 typed stale；
- `lastEmitted`：只在 value 真正对外消费后前进，不能因内部扫描或 merge slice 跳项。

list key 固定 `updatedAt DESC, historyId ASC`，search key固定 `rank ASC, updatedAt DESC,
historyId ASC, itemOrdinal ASC, itemId ASC`，items key固定 `itemOrdinal ASC, itemId ASC`。target、roles 等
filter 必须规范化并绑定 scan/cursor 状态。

## 实现边界

- child adapter 必须用有界 top-K frontier + traversal continuation，或等价的有界全局有序枚举。
  未扫描完整 snapshot 时允许返回空 values + scan continuation；不得提前发出仅批内有序的数据。
- continuation 要递归严格校验：version/kind/filter、canonical base64url（如编码）、safe integer、directory
  snapshot 和 traversal key；index/directory 变化稳定返回 `AGENT_HISTORY_CURSOR_STALE`。
- root 不能为分页 hydrate/write recovery store。`historyRecoveryReader` 可增加只读 SQL keyset scan port，复用同一
  executor；schema 每 session 一行。若 snapshot 需多阶段扫描，单次 source work仍须硬上限且只能在完整扫描
  后发出 values。
- targeted root/child record 要带稳定 source snapshot，供 060 的 legacy items cursor 绑定。
- canonical JSONL/五表、FTS schema、公开 capability、host commands均不在本叶修改。
- 现有 040 adapter API 若仍被测试/调用可保留兼容 facade；新 service-facing API必须让 060 不再猜测 traversal
  是否已全局有序。
- 若职责需要新增 helper/test，先把路径追加到本文件 frontmatter `files`；所有普通 owner `<=300`。

## 验收

1. child 至少两个 traversal 批次，第二批含更新 history，第一页仍返回真正全局 top；同 timestamp 用 historyId。
2. list/search 三页无重复遗漏；扫描中的空页可续；换 filter、坏 continuation、index/directory 变化按合同失败。
3. roles/target 在 legacy search source 内生效；source page 不产生无界 hits。
4. root 多 recovery row 可有界扫描并全局排序；tombstone/坏 row保持现有 fail-loud语义，不创建第二 store。
5. targeted record snapshot 在 generation/trace 内容变化后可供调用方判 stale。
6. 既有 040 tests 与新增 tests、`pnpm exec tsc -b --pretty false`、host-node build、boundaries、state、
   diff-check 通过；owners `wc -l <=300`。

## 禁止项

- 不把 filesystem path 加入 public history input/cursor；不新增 ACL/approval。
- 不把 traversal batch 的局部 sort 伪装成全局 page。
- 不反写 legacy trace/recovery，不回填 canonical，不新增第二 SQLite 数据库。
