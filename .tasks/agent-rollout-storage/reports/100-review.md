# 100 独立复审：并发、崩溃与回填

VERDICT: FAIL

## 阻塞问题

1. **C11 和“重启后保持顺序/tombstone”没有被集成测试证明。**
   `agentRollout.integration.test.ts:34-49` 自制了一个以进程内 `Set` 去重、直接
   `appendFile` 的 `fileDriver`；`agentRollout.integration.test.ts:67` 使用的是
   `createMemoryRecoveryDriver()`，不是任务要求的“只有 SQLite recovery snapshot 的旧 root”。
   所谓第二次启动（`:71-74`）仅新建 coordinator，继续复用同一个 driver 及其 `seen Set`，
   没有重建 rollout driver、SQLite recovery driver 或进程。后续 root/child 断言（`:76-106`）
   只读取自制 JSONL mutation，没有经过生产 codec、host store、SQLite projector，也没有在重启后
   核验 item 顺序、catalog complete 状态或 `a` 的投影 tombstone。报告中“模拟重启”“旧 SQLite
   recovery 回填”和“重启后保持”因此是测试未支持的结论。

2. **删除投影后的等价性断言不完整。**
   `rolloutRecovery.integration.test.ts:46-55` 的 `projection()` 只读取
   `agent_rollout_items` 的部分列，并只统计 catalog/events/items/state 行数；`:108-116` 的
   before/after 相等由此没有比较 catalog 内容、event 内容、projection state 的
   `next_byte_offset` / `next_rollout_ordinal`，也未比较 turns。任务明确要求报告并验证
   catalog/events/items/state/offset 与业务等价，当前测试只能证明 item 子集及表行数相同。

以上两项属于任务 100 明列的核心审计场景，不可由执行报告中的文字或相邻单元测试替代；应补成
真实 SQLite recovery + 生产 `createNodeAgentRolloutDriver` 的重启测试，并扩大 rebuild 快照后再复审。

## 已确认通过的证据

- 真双进程并发：`rolloutRecovery.integration.test.ts:26-43,64-74` 启动两个独立 Node
  process，各写 3 批 × 2 条；测试验证 JSONL 末字节为换行、ordinal 为 `0..11`，投影计数为
  `{catalog:1, events:12, items:12, state:1}`。不是同进程伪并发。
- crash window：`:77-97` 子进程在 append 流程第二次读取
  `agent_rollout_projection_state` 时经 IPC 发出 barrier 并挂起，父进程收到后 SIGTERM；按生产
  service 流程，该读取位于 source append + fsync 之后、projection apply 之前。新 driver 连续
  reconcile 两次后计数稳定为 `{catalog:1, events:1, items:1, state:1}`；无 sleep。
- rebuild source checksum：测试固定并通过 SHA-256
  `3defbf880a39e80996c6b7ff3d76b18fa762b940bb266a3b95ffcde28ac86d65`，重建前后不变；已验证计数
  `{catalog:1, events:3, items:2, state:1}`。但如阻塞问题 2 所述，offset/完整投影内容尚未验证。
- session delete / generation 隔离与 static no-driver 在公共 coordinator/recorder 边界有行为证据，
  但使用自制 driver；static recorder 未配置 driver 时调用 `recordSuccess()` 后临时目录文件集合不变，
  因而没有生成虚假 `complete:true` 文件。
- C01-C10、C12-C13 均能在本叶或报告列出的前序具体测试中找到对应行为；C11 的“真实 SQLite
  recovery-only + 真重启”仍缺失。C14、C15 按任务树明确不在本树范围。

## 亲自执行的验证

- `pnpm exec vitest run packages/host-node/src/rollout/rolloutRecovery.integration.test.ts packages/agent-core/src/runtime/agentRollout.integration.test.ts`
  → `2 files / 5 tests passed`。
- `pnpm exec tsc -b` → 通过。
- `pnpm check:boundaries` → 通过，仅输出既有观察项。
- `pnpm check:state` → 通过。
- `git diff --check` → 通过。
- 执行报告声称最终版本定向测试连续三次均 `2 files / 5 tests passed`；仓库中没有三次运行的独立日志，
  本次只能确认本人一次运行与报告记录，不能从持久证据复核另外两次。
- owner 文件当前为 119 / 132 行，均 ≤300，职责分别为物理恢复审计与运行时语义审计；无复杂文件例外。
  执行报告写 119 / 130，第二个数字已过期，但不单独构成阻塞。

## 未覆盖风险

- SIGTERM 不能模拟断电及硬件写缓存丢失；强持久化仍依赖 `FileHandle.sync()` 的平台保证。
- hot append 对同 inode、避开尾部 sentinel 的历史前缀原地篡改不会逐次全扫；显式 reconcile/rebuild
  才会全量验证。
- 当前并发测试覆盖两个短生命周期 writer；未覆盖进程长期持锁后异常停止、锁等待超时等运维情形。

---

## R1 correction 复审

VERDICT: PASS

上轮两个阻塞问题均已真实关闭。

### 1. SQLite-only 回填与真实重建边界

- `rolloutRecovery.integration.test.ts` 的 `backfills a SQLite-only root once...` 先通过生产
  `createSqliteRecoveryDriver()` 将 generation 7 snapshot 写入真实 SQLite；在创建 rollout driver
  之前没有 JSONL 写入者，因此起点确为 recovery-only。
- 首次 capture 使用生产 `createNodeAgentRolloutDriver`，数据经过 rollout codec、带锁 JSONL store 与
  SQLite projector。随后执行 `firstDriver.flush()` 并关闭旧 `DatabaseSync` 连接。
- restart 阶段重新构造 `DatabaseSync`、`SqlExecutor`、SQLite recovery facade、生产 rollout driver
  与 coordinator；没有复用 R0 的内存 `Set` 或自制 driver。旧 driver 虽仍处于局部词法作用域，但其
  executor 所属连接已关闭，后续调用全部明确使用新建对象，不影响重启语义。
- 新 recovery facade load 后再次 capture，断言 JSONL 行数不增长，证明幂等来自持久 JSONL/投影状态，
  而非进程内测试替身。
- 同一重建后的生产链再写 root update/reorder/delete 与 child 完整上下文。SQLite 投影明确验证
  `a@0 deleted`、`b@0` 内容更新为 `B2`、`c@1`，child item ordinal 顺序为
  `system,user,assistant,tool,user,assistant`，并验证 child catalog `complete=1`、turn status `done`。
  因而 root tombstone、重排及 child synthesis/run-state 均跨重建成立。

### 2. 五表完整重建等价

- `projection()` 现在对精确五张 rollout 表执行带稳定 `ORDER BY` 的 `SELECT *`：catalog、events、
  items、turns、projection_state。
- fixture 同时写入 session metadata、turn context、item upsert/delete 与 completed run state，确保五表
  的业务列都有覆盖。`dropRolloutProjectionSchema()` 后仅以 unchanged JSONL 交给新生产 driver
  reconcile，并对五表快照做 `toEqual` 深等价。
- 该比较包含 event JSON、catalog complete、turn/run state，以及 projection state 的 source path、
  `next_byte_offset` 和 `next_rollout_ordinal`；不再只是行数或 item 子集。
- 本轮固定 source SHA-256 为
  `f3fba497b36bb0330475b0c77b5c3372c8bc0e03afb8f58abdfeea380d3530d6`，重建前后相同；投影行数为
  `{catalog:1, events:6, items:2, turns:1, state:1}`。

### 覆盖与复跑

- C01-C13 仍均可指向本叶或执行报告列出的前序具体测试；其中上轮唯一缺失的 C11 已由上述生产
  SQLite recovery + 重建 driver 测试补齐。C08 真双进程、C09 IPC crash barrier、C10 五表纯源重建
  的证据保持成立；C12/C13 继续由公开 recovery writer 边界的 append spy 证明不会触碰 rollout。
- static no-driver 测试直接调用无 driver recorder 的 initial/success；该对象没有 append 能力，因而
  无法生成虚假 `complete:true` record。前序 Web persistence tests 负责 static 装配路径。
- 亲自执行定向两文件：`2 files / 6 tests passed`。
- 亲自复跑 `pnpm exec tsc -b`、`pnpm check:boundaries`、`pnpm check:state`、`git diff --check`：全部通过；
  boundaries 仅有既有观察项。
- 两个 owner 当前为 209 / 55 行，均 ≤300；职责分别是生产物理恢复审计和无物理存储的运行时隔离
  语义，符合单一职责。本轮未发现新的 C01-C13 覆盖缺口。

### 保留风险

- SIGTERM 仍不等价于硬件断电，fsync 语义最终依赖平台文件系统保证。
- 同 inode、避开尾部 sentinel 的历史前缀原地篡改仍须显式 reconcile/rebuild 才会全量发现。
- C14 旧 child archive 迁移与 C15 search/FTS/tools 按任务树明确属于后续范围。
