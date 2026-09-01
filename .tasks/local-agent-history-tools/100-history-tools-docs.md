---
id: "100"
title: 固化 global/legacy/search 语义
kind: leaf
parent: "5000"
depends_on: ["040", "060", "080"]
discovered_from: null
model: gpt-5.6-terra
status: cancelled
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - docs/agent-history-tools.md
  - docs/agent-rollout-storage.md
---

# 固化 global/legacy/search 语义

最小文档已合并进 070，不再单开叶任务。

## 目标

记录四工具的范围、完整性、索引与留存边界，使运维者不会把派生物或旧 trace 当成权威历史。

## 文档必须说明

- canonical 范围是同一机器 application-data 中全部 rollout，不按当前 workspace 过滤；target 没有 workspace identity。
- 所有 root/child 无 ACL 读取；没有 permission、approval、ancestor/sibling 限制或遮罩。
- JSONL 是原始证据，rollout 五表是读模型，FTS5 是第六类独立派生索引；分别如何 reconcile/drop/rebuild。
- running/terminal 的 `status/complete`；legacy root 与 child 的 `complete:false`、warning 与实际可见内容。
- legacy child 只从当前 ToolContext 绑定的 workspace locator 发现，trace 可被既有 archive retention 清理，不承诺永久。
- static Web 没本机 capability；Server Web/CLI 查询同一 app-data/SQLite。
- 四工具分页/读取/搜索上限、stale cursor 刷新方式、source/projection/search/legacy 错误分类。
- 当前没有 rollout delete/prune/compact/source repair；磁盘、用户手删 app-data、硬件损坏不属于“永久”保证。

`agent-rollout-storage.md` 只加查询层链接和职责图，不把 FTS 说成 rollout 第六表，不改已有运维命令语义。

## 验收

1. 文档不出现“current workspace only”“绝对永久”“需要授权”之类错误承诺。
2. FTS drop/rebuild、legacy partial、static unavailable 与实现名称一致。
3. `rg -n "ACL|permission|approval|ancestor|workspace identity|FTS5|complete" docs/agent-history-tools.md` 可定位所有裁决。
4. 两文档职责清晰；新文档 `<=300`，原 rollout 文档小改仍 `<=300`。
5. `git diff --check` 通过。

## 禁止项

- 不修改 retention script 或 373 行 `docs/tree-subagent-runtime.md`。
- 不新增产品代码、迁移/删除命令或 UI 承诺。
