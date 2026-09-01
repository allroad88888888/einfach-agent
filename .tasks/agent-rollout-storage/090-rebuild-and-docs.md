---
id: "090"
title: 提供离线重建与运维文档
kind: leaf
parent: "4000"
depends_on: ["050"]
discovered_from: null
model: gpt-5.6-terra
status: done
repair_round: 1
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - scripts/agent-rollout-rebuild.js
  - scripts/agent-rollout-rebuild.test.js
  - package.json
  - docs/agent-rollout-storage.md
  - packages/host-node/src/rollout/sourceCatalog.ts
  - packages/host-node/src/rollout/sourcePreflight.ts
  - packages/host-node/src/rollout/sourcePreflight.test.ts
  - packages/host-node/src/rollout/service.ts
  - packages/host-node/src/rollout/projectionSchema.ts
  - packages/host-node/src/rollout/index.ts
  - packages/host-node/src/index.ts
---

# 提供离线重建与运维文档

## 目标

提供只从 JSONL 重建 SQLite projection 的离线命令，并记录路径、故障语义、迁移边界和恢复手册。

## 命令合同

新增 package script `agent-rollout:rebuild`。默认只 report 将扫描的 app-data/文件数/字节数；必须显式
`--write` 才删除并重建 rollout projection tables。允许 `--database-path` 与 `--rollout-root` 指向测试或恢复副本；
拒绝 `/`、home、workspace root 等宽泛路径。命令永不修改、truncate、compact 或删除 JSONL。

实现应调用 host-node 的 projector/service 公共入口，不在脚本复制 schema/codec。

## 文档必须说明

- JSONL、query projection、recovery snapshot、undo log 各自职责。
- 各平台默认路径与 custom path；server/CLI 共用、static 无 driver。
- source 成功/projection 失败、半行、stale lock、rebuild 的处理步骤。
- session 删除不删除 rollout；当前没有 prune/delete，磁盘会增长。
- 旧 root 首次 capture 回填；旧 child trace 与 IndexedDB 不自动迁移。
- search/FTS/tools 在后续树，不能把 projection 表当稳定公共 API。

## 验收标准

1. dry-run 不改 DB；`--write` 删除投影后从 fixture JSONL 恢复等价 rows/state。
2. source corruption 返回非零并指出 file + byte offset，JSONL checksum 不变。
3. 危险路径被拒绝；临时目录与显式 DB path 可用。
4. `pnpm exec vitest run scripts/agent-rollout-rebuild.test.js` → 通过。
5. `pnpm agent-rollout:rebuild -- --help` → 退出 0 且参数与文档一致。
6. 脚本不超过 300 行；文档不内嵌实现源码。

## 禁止项

- 不提供 prune/delete/compact/repair-source 选项。
- 不迁移或伪造旧 child 缺失的 system/user 历史。
