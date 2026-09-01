---
id: "040"
title: 读取 legacy root/child
kind: leaf
parent: "2000"
depends_on: ["020"]
discovered_from: null
model: gpt-5.6-sol
status: done
repair_round: 3
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/host-node/src/history/legacyRootHistory.ts
  - packages/host-node/src/history/legacyRootHistory.test.ts
  - packages/host-node/src/history/legacyChildPath.ts
  - packages/host-node/src/history/legacyChildPath.test.ts
  - packages/host-node/src/history/legacyChildHistory.ts
  - packages/host-node/src/history/legacyChildHistory.test.ts
  - packages/host-node/src/history/legacyBoundedFile.ts
  - packages/host-node/src/history/legacyBoundedFile.test.ts
  - packages/host-node/src/history/legacyChildIndex.ts
  - packages/host-node/src/history/legacyChildIndex.test.ts
  - packages/host-node/src/history/legacyHistoryQuery.ts
---

# 读取 legacy root/child

## 目标

把未回填 recovery snapshot 与旧 child trace 投影为只读 compatibility source。

## legacy root

- 注入 `Pick<RecoveryDriver, 'listLatest'>`，复用现有 recovery driver 的 schema/codec 与 fail-loud corruption 语义。
- 只返回尚无 canonical catalog target 的 root；query service 负责 canonical 优先与去重。
- snapshot 内实际 `ConversationItem[]` 原样投影，不创建/hydrate session store，不写 rollout。
- 固定 `status:'legacy'`、`complete:false`、`LEGACY_PARTIAL_HISTORY`；warning 文案说明“非 canonical rollout”，
  不能错误声称 root snapshot 缺 system/user。

## legacy child

- 只接受逻辑 child target 与 provider 绑定的绝对 `legacyWorkspaceRoot`；公开 tool input 不接路径。
- `legacyChildPath.ts` 只负责在 root 下生成 `.webAgent-archive/conversations/<conversation>/runs/<run>/traces/<agent>.trace.jsonl`，
  segment 规范化必须与现有 archive fixture 对拍；realpath/containment 防止 locator 逃逸。
- list 可从 `.webAgent-archive/index/runs.jsonl` 发现当前 locator 下的旧 run；索引的 `archiveBasePath` 是权威物理
  locator，必须校验固定布局、与逻辑 ID 的既有 segment 规范化绑定及 realpath containment；它不能伪装为 global catalog。
- trace 只接受 `{timestamp,turn,item}` 中的 assistant/tool；坏行跳过并返回 `MALFORMED_LEGACY_RECORD`；
  固定 `status:'legacy'`、`complete:false`、`LEGACY_PARTIAL_HISTORY`，不补造 system/user/synthesis。
- trace 单文件最大 2 MiB；所有文件使用同一打开句柄做 cap+1 的有界读取，不允许 stat→readFile 竞态；目录用
  `opendir` 有界迭代。list/search 对检查项、legacy histories 与实际读取字节设硬上限，命中即停止。
- child discovery 接收/返回独立 `{records,warnings,truncated,continuation}` envelope；即使零 records 也保留截断
  warning。continuation 绑定索引 snapshot 与“最后已消费”run/agent key，恢复时校验 snapshot 并从该 key 之后继续；
  永久 oversized trace 算已消费并带 warning，下一页不得漏掉后续项或卡在同一项，供 060 铸造公共 cursor。
- directory-entry cap 的 continuation 还必须记录当前 run 内“最后已检查目录项”的恢复点；下一页跳过该前缀后
  才重新计本页 cap，不能在第 257 项永久重复截断。目录在页间变化时应 fail-stale，而不是静默错页。
- root/child search 返回内部 envelope，不得丢 `LEGACY_PARTIAL_HISTORY`、malformed、truncated 或 continuation；
  untargeted child search 接收同一 continuation。`legacyHistoryQuery.ts` 只定义这些内部 query envelope/continuation。

两个 adapter 提供 list/items/read/search 所需的同构内部方法，供 060 合并；不实现 ACL、retention 或迁移。

## 验收

1. recovery-only root 能 list/items/read/search；canonical target 集合传入后同 target 不重复。
2. child trace assistant/tool 顺序可读；坏行不吞后续合法行；缺 workspace locator 时只是不发现 legacy child。
3. `../`、绝对 agentPath、symlink/path escape 拒绝；工具合同仍只含逻辑 target。
4. 任一 adapter 都不写文件/SQLite，不调用 CoreInstance store，不改 `.webAgent-archive` retention；recovery corruption 不得静默吞掉。
5. `pnpm exec vitest run packages/host-node/src/history/legacyRootHistory.test.ts packages/host-node/src/history/legacyChildPath.test.ts packages/host-node/src/history/legacyBoundedFile.test.ts packages/host-node/src/history/legacyChildIndex.test.ts packages/host-node/src/history/legacyChildHistory.test.ts` 通过。
6. `pnpm exec tsc -b`、`pnpm check:boundaries` 与 owners `<=300` 通过。

## 禁止项

- 不把 legacy 反写 JSONL/FTS，不把坏 canonical source 降级到 legacy。
- 不依赖 UI atoms、`archiveIO.ts` 或 cwd 猜 workspace。
