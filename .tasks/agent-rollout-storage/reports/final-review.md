# Agent rollout storage 最终独立总审查

VERDICT: PASS

## 结论

整棵任务树已经形成闭环：统一合同与严格 codec 只接受逻辑 target；application-data 路径进入带
owner 身份保护的 per-history lock；JSONL 批追加以换行和 `FileHandle.sync()` 作为强边界；SQLite
五表仅作可重放投影；service 在同一 source lock 内完成追平、五类 mutation 去重、append 与投影，
并把 source 错误设为 fatal、projection 错误设为可追平 warning。root recovery fence、child 完整模型
上下文、Web/CLI 装配、离线 rebuild 与最终真实进程故障测试消费的是同一组公共合同。

未发现 Critical 或 Important 问题。C14 旧 child archive 迁移与 C15 search/FTS/tools 按 index 明确
在本树范围外，没有被实现或测试伪装成已完成。

最终全仓首轮测试暴露的四个稳定失败是新增公开面/命令后的陈旧精确计数契约。discovered leaf 110
已把 boundary 自测同步为十个入口（根 barrel + 九个 subpath），把 host command 全集同步为 42 条，
保留白名单负例和命令唯一性断言；R1 独立复审 PASS。它没有放宽边界规则或改变产品行为。

## 关键链路复核

- 合同/codec：五种 mutation、必填规范化字段、严格 key/schema/ordinal/timestamp/ModelItem 边界一致；
  core root barrel 没有继续扩张，公开入口为 `@einfach-agent/core/history`。
- 路径/源存储：逻辑 target 经摘要映射到 canonical path；同 history 使用独立跨进程 lock，live PID
  不因 mtime 被抢，malformed/dead owner 的恢复带 generation identity；批次只追加一次并 fsync。
- 投影/service：只维护 catalog/events/items/turns/projection_state 五表；record upsert 后再推进 byte
  offset，重放幂等；append 前 source corruption fail-closed，projection 故障仍保留 source evidence
  并返回 typed warning。hot path 使用 inode/offset/ordinal/尾部 sentinel 增量校验，显式 reconcile/rebuild
  全量校验。
- root：snapshot delta 对 update/reorder/delete 产生稳定 mutation；rollout append 先于 recovery save，
  失败返回 error outcome 并阻断下一次 model loop；session delete/undo generation 不触碰 rollout。
- child：initial system/user、assistant、tool result、synthesis user、terminal state 都在下一次模型调用或
  done finalize 前 await；nested/sibling 使用自己的 agentPath；static no-driver 是显式 no-op。
- Web/CLI：server Web 在 hydrate/new-session/render 前 reconcile，source warning 不落入 recovery fallback；
  static Web 不创建文件 driver。CLI root/child/host routes 共用一个 borrowed driver，只登记一个按
  recovery→rollout 排序的 persistence disposer；shutdown allSettled、幂等 drain、晚登记与双信号语义
  均有入口测试。
- rebuild：先对全部 canonical source 做有界 preflight，再打开 SQLite；只 drop 精确五表，路径 realpath
  防护和 DB/source disjoint 检查不会越界修改 JSONL、无关表或 future rollout 表。

## 覆盖矩阵

- C01–C07：server root、root delta、child 完整上下文与 nested/sibling、CLI direct、static Web、跨平台/
  custom path 均能指向 020/060/065/070/080 的定向测试。
- C08：两个独立 Node process 各写 3 批 × 2 record；JSONL ordinal 为 `0..11`，完整换行；投影行数
  `{catalog:1, events:12, items:12, turns:0, state:1}`。
- C09：child-process IPC barrier 位于 source fsync 后、projection state 读取前；SIGTERM 后新 driver
  连续 reconcile 两次仍为 `{catalog:1, events:1, items:1, turns:0, state:1}`。
- C10：删除五表后只靠 unchanged JSONL 重建，五表 `SELECT *` 快照深等价；source SHA-256 前后均为
  `f3fba497b36bb0330475b0c77b5c3372c8bc0e03afb8f58abdfeea380d3530d6`，行数为
  `{catalog:1, events:6, items:2, turns:1, state:1}`，包含 offset/next ordinal。
- C11：先写真实 SQLite recovery generation 7，再创建生产 rollout driver；关闭并重建 SQLite connection、
  recovery facade、driver、coordinator 后第二次 capture 不增加 JSONL 行数。
- C12–C13：公开 RecoveryWriter 边界证明 delete、tombstone 与 generation-only capture 不新增 append；既有
  recovery/undo suites 通过。
- C14–C15：明确范围外，未发现实现越界。

## Findings

### Critical

无。

### Important

无。

### Minor

1. `sourcePreflight.test.ts` 的 oversized-line 场景用 31-byte chunk 扫描超过 1 MiB 数据。在一次 27 文件
   默认并发组合中它与 rebuild happy-path 各触发 5 秒默认 timeout；隔离复跑曾再次超时一次，随后
   该两文件组合连续三次通过，完整相关组合限制为 4 workers 后 27 files / 146 tests 全通过。这不显示
   产品逻辑错误，但该人为极小 chunk 用例对共享 runner 负载敏感；后续可把 chunk 调到仍跨多块但不会
   执行约 3.4 万次异步 read 的尺寸，或给该压力用例显式 timeout。最终全仓受控并发运行已通过，
   因而本项仅是 runner 资源敏感性，不是未通过的验收门。

## 亲自验证

- `pnpm exec vitest run packages/host-node/src/rollout/rolloutRecovery.integration.test.ts packages/agent-core/src/runtime/agentRollout.integration.test.ts`
  → 2 files / 6 tests passed。
- 关键相关 27 文件组合（history、host rollout、root/child runtime、Web/CLI、rebuild）以
  `--maxWorkers=4` 运行 → 27 files / 146 tests passed。
- `sourcePreflight.test.ts` + `agent-rollout-rebuild.test.js` 连续三次 → 每次 2 files / 18 tests passed。
- 110 定向 `scripts/check-boundaries.test.js packages/host-node/src/commandNames.test.ts`
  → 2 files / 18 tests passed；独立 R1 review PASS。
- 最终 `pnpm exec vitest run --maxWorkers=4` → 729 files passed / 3 skipped，6057 tests passed /
  3 skipped，exit 0（141.54s）。首轮陈旧计数失败已由 110 关闭；sourcePreflight 的高并发 timeout
  在受控并发下未复现。
- `pnpm exec tsc -b` → passed。
- `pnpm check:boundaries` → passed，仅输出既有豁免观察项。
- `pnpm check:state` → passed。
- `git diff --check` → passed。

## 文件边界

本树（包含 discovered leaf 110）新增/大改普通源文件与测试文件均不超过 300 物理行。最高的相关文件为
`childAgentLoop.ts` 294、`childAgentToolCalls.ts` 292、`projector.ts` 287；新增集成测试为 209/55。
未见 `part1`、`xxx2` 或新建大杂烩 `utils`。扫描中出现的 327 行
`apps/web/src/mcp/persistence.test.ts` 不属于本树 owners，也未被本树修改，故不构成阻塞。
`pnpm-lock.yaml` 5465 行属于 lockfile 生成物例外。

## 残余风险

- SIGTERM 故障注入不能等价模拟断电或硬件 write cache 丢失，最终持久性依赖平台对
  `FileHandle.sync()` 的保证。
- hot append 只用上次边界附近 128-byte sentinel 防止历史前缀被改写；同 inode 且避开该 sentinel 的
  早期原地篡改不会在每次 append 全扫发现，但显式 reconcile/rebuild 会全量拒绝。这是已记账的性能/
  篡改检测取舍，不影响 append-only 正常写入模型。
- 当前多进程测试覆盖短生命周期 writer 与 crash barrier，未覆盖活进程永久持锁后的人工运维恢复；
  设计选择是宁可 timeout，也不抢 live PID 的 lock。
