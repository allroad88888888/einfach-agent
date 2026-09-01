# 100 执行报告：并发、崩溃与回填审计

结论：DONE。只新增两份集成测试，没有修改产品代码。

## 修改摘要

- `rolloutRecovery.integration.test.ts`：经真实 Node 子进程、生产 rollout driver、真实 SQLite recovery、真实 JSONL 与五表投影，审计并发、崩溃、重启回填、root/child 语义和纯源重建。
- `agentRollout.integration.test.ts`：只在公开 writer/recorder 生命周期边界审计 generation/delete 隔离与 static no-driver；不再自制文件 driver 或声称它是重启证据。
- 文件职责分别是“生产物理恢复审计”和“无物理存储的运行时隔离语义”；物理行分别为 209、55，均低于 300。

## 场景与覆盖矩阵

| 场景 / 矩阵 | 本叶或前序具体证据 |
| --- | --- |
| 两进程多批并发 / C08 | `rolloutRecovery.integration.test.ts` → `serializes multiple batches from two independent processes`：两个 Node process 各 3 批、每批 2 条；12 条 JSONL ordinal 精确为 0..11，结尾换行完整；投影 `{catalog:1,events:12,items:12,state:1}`。 |
| fsync 后投影前终止 / C09 | 同文件 → `reconciles exactly after termination...`：executor 第二次读取 projection state 时通过 IPC 发出 `after-fsync` barrier，父进程收到后 SIGTERM；新 driver 连续 reconcile 两次仍为 `{1,1,1,1}`。无 sleep。 |
| 删除投影、纯源重建 / C10 | 同文件 → `rebuilds an equivalent projection solely from unchanged JSONL`：对五表执行稳定 `ORDER BY` 的 `SELECT *` 快照，完整覆盖 catalog、events/event JSON、items、turn/run state、projection source path/byte offset/next ordinal。drop 精确 schema 后只用 unchanged JSONL reconcile，快照深等价；SHA-256 前后均为 `f3fba497b36bb0330475b0c77b5c3372c8bc0e03afb8f58abdfeea380d3530d6`；逐表行数 `{catalog:1,events:6,items:2,turns:1,state:1}`。 |
| server root / C01 | 本叶崩溃/重启投影测试；前序 `modelRunLifecycle.recovery.test.ts` 与 `main.serverHost.test.tsx` 覆盖真实入口装配。 |
| root delta / C02 | `rolloutRecovery.integration.test.ts` → `backfills a SQLite-only root...` 经生产 codec/projector 验证 update/reorder/delete：投影为 `a@0 deleted`、`b@0=B2`、`c@1=C`；前序 `agentRolloutCoordinator.test.ts`。 |
| child 完整上下文 / C03 | 同一生产集成测试经 child recorder→生产 JSONL codec→SQLite projection，按 item ordinal 得到 `system,user,assistant,tool,user,assistant`，catalog `complete=1`、turn status `done`。 |
| nested/sibling / C04 | 前序 `runtime.childRollout.test.ts` → `uses each runtime node path...`。 |
| CLI direct / C05 | 前序 `apps/cli/src/runtime.test.ts` 的真实 CLI assembly/model-run 顺序验收。 |
| static Web / C06 | `agentRollout.integration.test.ts` 的无 driver recorder 完成 initial/success 且无任何 append 能力；前序 `main.serverHost.test.tsx`/Web persistence tests 验证装配路径。 |
| 跨平台/custom path / C07 | 前序 `rolloutPath.test.ts` 与 app-data path tests。 |
| 旧 SQLite recovery 回填 / C11 | host 集成测试先仅向真实 `recovery_snapshots` 写 generation 7（尚无 JSONL）；首次 coordinator capture 回填。随后关闭数据库，重建 SQLite connection、SQLite recovery facade、生产 rollout driver、coordinator，再次 load/capture，JSONL 行数不增长。 |
| session delete / C12 | core 生命周期测试的 append spy 确认首次 capture 后 delete + tombstoned persist 不再 append；生产文件“不提供 delete API”由 host service 合同保证。 |
| recovery/undo generation / C13 | core 生命周期测试确认 recovery generation 1→2 时 append 次数不增长，delete fence 同样不 append；前序 recovery/undo tests 保持通过。 |

## 验证结果

- 定向两文件最终版本连续运行 3 次：每次 `2 files / 6 tests passed`，无时间戳等待或 sleep。
- 相关测试：`packages/host-node/src/rollout`、root coordinator/writer/model lifecycle、child recorder/runtime、rebuild script，共 `15 files / 94 tests passed`。
- `pnpm exec tsc -b`：通过。
- `pnpm check:boundaries`：通过（仅既有观察项）。
- `pnpm check:state`：通过。
- `git diff --check`：通过。
- `wc -l`：209 / 55；无复杂文件例外。

## 未覆盖风险

- 测试用 SIGTERM 模拟进程终止，无法在普通 Vitest 中证明真实断电时文件系统/硬件写缓存行为；生产强边界依赖 `FileHandle.sync()` 的平台保证。
- 同 inode 且避开尾部 sentinel 的历史前缀原地篡改不会由 hot append 每次全扫；显式 reconcile/rebuild 会全量验证。该限制已在 050 审查中记账。
- 本叶不迁移旧 child workspace archive（C14），search/FTS/tools（C15）仍按任务树明确范围外。
