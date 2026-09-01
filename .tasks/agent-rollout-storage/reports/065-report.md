# 065 执行报告

状态：DONE（R1 已修复）

## 实现

- 新增 root rollout coordinator：基于 060 delta 计算增量，仅在 append 成功后推进每个 session 的 previous snapshot；首次 capture 完整回填，相同 capture 不重复写。
- RecoveryWriter 在同一份同步 capture 上按 `rollout append → recovery save` 排序执行。rollout 失败返回 `RecoveryWriteOutcome {status:'error'}` 且 recovery 不发生；recovery 失败保留已追加 rollout，重试时 delta 为空。
- session delete 与 writer reset 显式清理 coordinator previous；删除仍只写 recovery tombstone，不调用 rollout delete。对 delete/reset 与在途 append 的竞态也会再次清理 previous。
- R1 lifecycle 修复：reset 原子替换 coordinator 实例，入队任务捕获其所属实例；旧在途 append 只能清理旧 lifecycle，不能删除新 lifecycle 已确认的 previous。
- R1 failure 修复：rollout reject 在 writer 内转为 error outcome，既有 fire-and-forget 调用不会产生 unhandled rejection；模型入口继续通过 outcome 阻断执行。
- `PersistenceDependencies` 增加可选 `agentRollout`，未配置时保持原行为。
- 将 recovery 成功后的 paired undo-log flush 抽到 `persistedHistoryLogFlush.ts`，保留 best-effort 与 generation 配对语义。

## 验证

- 指定 Vitest：3 files / 10 tests passed。新增 gate 交错覆盖 `A 阻塞 → reset → B 成功 → A 返回 → C 去重`，并覆盖模型 fence 与未配置 rollout driver。
- 既有 recovery / persistence bridge 回归：3 files / 24 tests passed。
- `pnpm exec tsc -b --pretty false`：通过。
- `pnpm check:state`：通过。
- `pnpm check:boundaries`：通过（仅既有观察项）。
- `git diff --check`：通过。
- 7 个产品/测试文件均不超过 300 行；最高 `recoveryWriter.ts` 253 行。

## 关注项

无。
