# 050 执行报告（R3）

状态：DONE

## R3 correction

- `afterAppend` 在 fsync 后执行的增量 source validation/open/stat/read/close/codec/identity/ordinal 失败现在包装为 `RolloutSourceError` 并直接 reject append Promise；不会降级成 warning。
- post-project 仅 `RolloutProjectionError`/SQLite projection failure 可返回 `kind:'projection'` warning；projector 返回 source warning 或 source identity mismatch 会转为 fatal rejection。
- store 的 `prepared.projectionWarning ?? finalizedWarning` 无法遮蔽 source fatal：`afterAppend` source failure 在 warning merge 前抛出。
- 普通组合测试证明：source 已 fsync 保留一条 JSONL evidence，但 append 与首次 flush reject；健康 driver 修复后先 reconcile，再对相同 mutation dedupe 为零新增。
- 复合组合测试证明：prepare 已产生 projection warning，source durable append 后 incremental validation 故障仍 reject；JSONL 保留两条 evidence，健康重试收敛且不写第三条。

## R3 修复

- projector operation wrapper 现在由当前边界强制 brand：
  - source boundary 收到 `RolloutProjectionError` 时包装成 `RolloutSourceError`，原错误保留为 `cause`。
  - projection boundary 收到 `RolloutSourceError` 时包装成 `RolloutProjectionError`，原错误保留为 `cause`。
  - injected executor、projection fault hook、source fault seam 的相反品牌均有测试。
- `sourcePreflight.ts` 扩展为全量/增量共用的唯一验证器 `validateRolloutSource`，继续复用同一 codec、canonical path/identity 与 ordinal 规则；090 的 `preflightRolloutSources()` 对外返回仍严格保持 `{ files, bytes }`。
- 每个 Node rollout driver 按 canonical source 缓存内部 validation state：打开句柄的 bigint `dev/ino`、validated byte offset、next ordinal，以及 offset 前 128-byte prefix sentinel。
- 首次 append/cache miss 做一次 bounded 全量验证；后续 append 在 prepared target lock 内只验证 cached offset 之后的新 tail。另一 driver/process 合法 append 会作为 tail 被读取，不会重扫旧前缀。
- afterAppend 在同一 lock 内先增量验证刚写入的 source并更新 cache，再投影；即使 projection 失败，下次 append 仍从最新安全 offset 开始。
- 显式 reconcile 对每个 canonical source做全量 bounded验证并刷新 cache。
- cached source 的 truncate、rename replacement、prefix rewrite、identity/ordinal mismatch、corrupt/partial/oversized tail 均在 source write 前 fail-closed；缓存缺失允许一次全量 state 重建。

## 聚焦测试

- executor 与 `afterRecordUpsert` 故意抛 `RolloutSourceError`，结果强制为 projection 且 cause 保留。
- source operation 故意抛 `RolloutProjectionError`，结果强制为 source 且 cause 保留。
- source validation 覆盖 incremental tail、truncate、rename replacement、corrupt tail、cache miss full rebuild。
- hot append byte observer 覆盖 8 次连续 append、另一 driver append tail、最终 append；累计 validation chunk bytes 精确等于最终 JSONL 大小，证明未重复扫描前缀。
- R1/R2 的跨进程 dedupe、五类 mutation、strict command、source/projection warning、corruption fence、driver injection 与 flush 覆盖保持通过。

## 验证

- 定向 Vitest（sourcePreflight/service/commands/projector/createNodeHostInvoke）加 090 rebuild：通过，6 files / 49 tests。
- 修正后核心 R3 定向复跑（sourcePreflight/service/projector）：通过，3 files / 23 tests。
- `pnpm exec tsc -b`：通过（exit 0）。
- `pnpm --filter @einfach-agent/host-node build`：通过。
- `pnpm check:boundaries`：通过，仅既有豁免观察项。
- `pnpm check:state`：通过。
- `git diff --check`：通过。
- 行数：projector 287、service 205、service test 212、sourcePreflight 157，其余 R3 文件更小；全部低于 300。

## 范围

- 仅修改 R3 更新后的 050 owners 与本报告。
- 未修改 080 owners、090 sourceCatalog、index 或任务文件；未 commit。
