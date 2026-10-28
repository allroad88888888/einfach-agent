# 070 R1 独立复审

结论：**PASSED**

复审范围：仅核对 `070-review.md` 中一个 Critical、两个 Important 的修复，以及这些修复对 070 关闭合同的直接影响。未启动浏览器，未重跑报告和编排已通过的测试；最终全仓测试与构建由编排统一收口。

## 原 findings 关闭情况

### Critical 1：恢复写失败仍释放 namespace owner

✅ 已关闭。

- `persistHostShutdownRecovery` 现在读取真实 `RecoveryWriteOutcome`；只有未配置 recovery driver 的 `undefined` 兼容结果和已确认落盘的 `saved` 可以成功返回。`error`、`skipped`、`tombstoned` 均抛错（`packages/agent-core/src/runtime/commands/runLifecycleCommands.ts:246-258`）。
- `dispose` 在 `Promise.all(core.interruptRunForRecovery(...))` 之后才执行 flush、reset 与 owner release；中断持久化抛错时，控制流不会到达这些操作，首次 dispose 的 rejected Promise 仍被重复调用复用（`browser-agent/agent/src/client.ts:161-178`）。
- 新测试没有用直接 reject 的 facade mock 规避问题：它给真实 persistence bridge 配置一个在 `loadLatest` 抛错的 recovery driver，由 `RecoveryWriter` 将失败转换成 resolved `{status:'error'}`，随后验证 dispose 拒绝、Promise 身份不变、同 namespace 第二 client 仍因 owner 被占用而拒绝（`browser-agent/agent/src/hostCloseRecovery.integration.test.ts:41-61`）。这精确覆盖了原审查指出的失效链路。

### Important 1：缺少 preserveRecovery 双实例隔离证据

✅ 已关闭。

新增测试让 A、B 各自进入 pending fetch，仅对 A 调用 `dispose({ preserveRecovery:true })`，断言 A signal 已取消、B signal 未取消且随后正常完成；之后同 namespace 重建 A 并续跑至 done（`browser-agent/agent/src/hostCloseRecovery.integration.test.ts:63-106`）。覆盖了关闭 A 不影响 B 以及 A 可恢复两个要求。

### Important 2：等待决策与未知外部写入缺少重建证据

✅ 已关闭。

- `waiting_confirmation` 用真实 browser agent + fake IndexedDB 完成 dispose、释放 owner、同 namespace 重建，恢复状态为 `awaiting_user`，并保留 `pendingToolConfirmation` 的 call、tool 和 reason（`browser-agent/agent/src/hostCloseRecovery.integration.test.ts:108-131`）。
- unknown 外部写入同样经过持久化重建，恢复后为 `reconciliation_required`；调用 `continueRecoveredSession` 仍返回 reconciliation，且模型 fetch 与工具 execute 均未发生（`browser-agent/agent/src/hostCloseRecovery.integration.test.ts:133-165`）。

## 验收复核

1. ✅ pending fetch 取消、同 namespace 重建、recoverable/续跑、迟到响应隔离已有首轮证据；R1 又补齐真实 recovery outcome 失败时拒绝交接并保留 owner。
2. ✅ 默认 dispose/显式 stop 的 stopped 语义保留；R1 补齐 preserveRecovery 下 A/B 运行隔离。
3. ✅ paused decision 与 unknown 外部写入现已通过 fake IndexedDB 重建验证，unknown 不自动重放。
4. ✅ 报告记录 agent 6 files / 25 tests、core 恢复 9 files / 71 tests通过，并如实保留组合装载竞态说明；本复审未重复运行。
5. ✅ R1 报告记录 core/agent build、state、boundaries、docs、dist 与 diff 门禁通过；最终全仓测试和构建由编排收口。
6. ✅ README 的默认关闭和宿主恢复关闭说明与修复后的成功交接语义一致。

未发现新的 Critical、Important 或 Minor 问题。070 可进入编排最终门禁。
