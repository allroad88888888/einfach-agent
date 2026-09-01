# Agent rollout storage 第二次独立终审

VERDICT: PASS

## 结论

从所有 leaf frontmatter 的共同基线 `d88409306988d6427877c76cbba9658dd5fa727e` 到当前工作区，
本树 owner 已形成可运行闭环。未发现 Critical、Important 或 Minor 缺陷，也未发现第一位终审遗漏的
跨叶合同错配、以 mock 冒充生产集成、错误分类反转或未记账的删除路径。

本审查只覆盖 `.tasks/agent-rollout-storage` 声明的 owner；`.tasks/local-agent-history-tools` 与其他用户
改动未纳入裁决，且本次未修改任何产品、测试、task 或 index 文件。

## Findings

### Critical

无。

### Important

无。

### Minor

无。

## 关键证据

- JSONL 强边界：`packages/host-node/src/rollout/jsonlStore.ts:128-160` 在 per-history queue 与跨进程
  lock 内准备批次，读取尾记录分配连续 ordinal，一次 append 后 `FileHandle.sync()`，再执行投影；
  `rolloutLock.ts:54-70,150-180` 只回收 dead PID 或达到 stale age 的 malformed owner，存活 PID 不按
  mtime 抢锁，claim 时再次核对文件身份与内容。
- crash window 与去重：`service.ts:123-171` 在同一 source lock 内先校验、追平和按五类 mutation
  当前状态去重，再 append；source corruption 拒绝写，projection 故障返回 typed warning。
  `projector.ts:227-282` 每条 record 先幂等投影，再推进 byte offset，因此中间崩溃只会重放，不会重复
  event/item。显式 reconcile 通过 `sourcePreflight.ts:83-139` 全量校验路径身份、ordinal、换行和大小。
- SQLite 五表：`projectionSchema.ts:3-67` 仅定义 catalog/events/items/turns/projection_state；
  `projector.ts:74-146` 对五类 mutation 的最新状态、tombstone、run completion 与 event audit 分别投影。
  真实集成测试会 drop 五表后仅靠未改 JSONL 重建，并对五表 `SELECT *` 深比较。
- root fence：`agentRolloutCoordinator.ts:18-31` 仅在 append 成功后推进 previous snapshot；
  `recoveryWriter.ts:125-178` 严格执行 rollout capture → recovery save，并将 rollout failure 转成
  `status:'error'`。现有 timed-dispatch/tool-call fence tests 消费该 outcome，阻断后续模型或依赖动作。
  session delete 只清 coordinator 内存并调用 recovery delete（`recoveryWriter.ts:224-246`），没有 rollout
  delete API；undo generation 仍由原 recovery/history-log 路径负责。
- child 完整上下文：`childAgentLoop.ts:211-280` 在首轮模型请求前 await initial context，在每个下一轮请求前
  await synthesis/assistant/tool item，并在成功 finalize 前写 terminal state；
  `childRolloutRecorder.ts:35-82` 用 conversation/run/agentPath 构造唯一 target 和稳定 item ordinal。
  nested/sibling 不共享 target；无 driver 时 recorder 是显式 no-op，不会生成伪 `complete:true`。
- 生命周期：server Web 在 recovery fallback 外先 reconcile 并拒绝 source warning（`apps/web/src/main.tsx:130-147`）；
  static driver assembly 不创建文件 driver。CLI 直接创建一个 Node driver，root persistence 与 host routes
  借用同一实例（`apps/cli/src/persistence.ts:34-67`、`runtime.ts:105-139`）；borrowed host 不登记 rollout
  disposer（`createNodeHostInvoke.ts:133-148`），CLI 只登记一个按 recovery→rollout 排序的 persistence
  disposer，正常结束与 signal 共用幂等 drain。
- 离线 rebuild：`scripts/agent-rollout-rebuild.js:53-89` 对 override 做 absolute、realpath、protected-root、
  basename 与 DB/source disjoint 防护；`rebuild():91-107` 在打开 SQLite 前完成所有 canonical source
  preflight，只 drop 精确五张投影表，绝不修改 JSONL。
- C01-C13 均有生产路径或真实 SQLite/子进程集成证据；C08 使用两个独立 Node writer，C09 用 IPC barrier
  固定 fsync 后/投影前 crash window，C10/C11 重建连接与生产 driver 后验证五表、offset、tombstone、顺序
  和幂等 backfill。C14、C15 按 index 明确属于后续范围，没有被伪报为本树交付。

## 亲自验证

- 定向 Vitest（host rollout 全目录、core history、root/child integration、Web/CLI assembly、rebuild、最终
  boundary/command 契约）→ `28 files passed / 157 tests passed`，包含真实双进程、crash barrier、五表重建
  与 SQLite-only root backfill。
- `pnpm exec tsc -b` → passed。
- `pnpm check:boundaries` → passed（仅既有批准观察项）。
- `pnpm check:state` → passed。
- `git diff --check` → passed。
- owner 物理行扫描：所有本树新增/大改普通文件均 `<=300`；最高为 `childAgentLoop.ts` 294、
  `childAgentToolCalls.ts` 292、`projector.ts` 287。未见 `part1`、`xxx2` 或新增大杂烩 `utils`。

## 残余风险

- SIGTERM 故障注入不能证明硬件断电或设备 write-cache 行为；最终强持久性仍依赖目标平台对
  `FileHandle.sync()` 的保证。
- hot append 以 inode、offset、ordinal 和边界前 128-byte sentinel 做增量验证；同 inode 且避开 sentinel
  的早期原地篡改要到显式 reconcile/rebuild 的全量 preflight 才会发现。这是已记账的性能取舍。
- live PID 永不按 stale age 抢锁；进程存活但永久卡死时会 timeout，需要退出进程或人工处置，而不会冒险
  产生重复 ordinal。
