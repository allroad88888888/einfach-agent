# 070 独立审查

结论：**REJECTED**

审查范围：按任务说明仅审查 070 新增的宿主关闭恢复合同、直接影响的 core 迟到路径、测试与文档；`070-scope.diff` 中已由 010 审查的其余变更不重复裁决。未启动浏览器，未重跑已通过测试。

## Findings

### Critical

1. 恢复快照写失败仍会成功完成 `dispose` 并释放 namespace owner，可能让新实例在未保存宿主关闭状态时接管同一 namespace。

   `RecoveryWriter` 明确把捕获失败、driver 异常和 stale 重试耗尽转换成 resolved 的 `{ status: 'error' }`，而不是 rejected Promise（`packages/agent-core/src/runtime/recoveryWriter.ts:18-22,176-182,208-222`）。但 `interruptRunForRecovery` 在有无 run 的两个分支都用 `.then(() => undefined)` 丢弃结果（`packages/agent-core/src/runtime/commands/runLifecycleCommands.ts:215-239`）。因此 `BrowserAgentClient.dispose({ preserveRecovery: true })` 的 `Promise.all` 和后续 `persistence.flush()` 均可正常完成，随后执行 `persistence.reset()` 与 `owner.release()`（`browser-agent/agent/src/client.ts:161-177`）。

   这直接违反任务约束“错误持久化必须可观察且不伪报安全保存；未真正完成 flush 前不得让并发 owner 开始覆盖旧状态”，也与执行报告“flush 失败会拒绝同一个 dispose promise，且不会提前释放 owner”的声明不符。需要让关闭路径检查每个恢复写结果，只在可接受的 durable outcome 下释放 owner；`error`（以及对关闭语义不安全的其他 outcome）必须拒绝 dispose 并保留 owner。应以真实 recovery driver 返回/抛错形成 `{status:'error'}` 的集成测试覆盖，不能只用一个直接 reject 的 mock Promise 替代该路径。

### Important

1. 验收 2 的“双实例 A/B：关闭 A 只取消 A，B 仍可运行”没有针对新增 `preserveRecovery` 路径的直接证据。新增集成测试只覆盖单实例恢复关闭（`browser-agent/agent/src/client.integration.test.ts:118-157`）；010 的默认 stop 隔离证据不能完整替代这条新关闭方式。修复 Critical 后应补一个真实双 client、两个 pending fetch 的用例，验证 A 的 signal 取消且恢复、B 的 signal 和运行不受影响。

2. 验收 3 要求等待决策和未知外部写入“重建后”仍保持语义。新增 core 测试只在同一内存实例中断后断言状态（`packages/agent-core/src/runtime/commands/runInterruption.test.ts:48-100`），没有经过 fake IndexedDB 的 dispose、释放 owner、同 namespace 重建链路。尤其持久化失败正是本次实现的薄弱环节，因此内存断言不足以证明验收。应为 paused decision 与 unknown outcome 各补至少一个真实持久化重建断言，并确认 unknown 为 `reconciliation_required` 且不触发请求/工具重放。

### Minor

无。

## 验收逐项

1. ❌ 正常写盘路径覆盖了 pending fetch 取消、立即同 namespace 重建、recoverable、续跑完成与旧迟到响应不写回；但恢复写失败仍释放 owner，关闭合同未成立。
2. ❌ 默认 dispose / 显式 stop 的 stopped 语义有证据；缺少新增恢复关闭路径下 A/B 隔离的直接测试。
3. ❌ 内存层覆盖 paused decision、`notStarted`/unknown 与 reconciliation；缺少任务明确要求的重建后端到端证据。
4. ✅ 报告列出 agent 21 项、core 恢复 71 项通过；编排亲验 agent src 与 `runInterruption` 共 6 files / 27 tests 通过。组合 invocation 的装载竞态已如实披露。本审查按约束未重复运行测试。
5. ✅ 报告列出的 core/agent build、state、boundaries、docs、dist 与 diff 检查覆盖要求的结构门禁；未无故运行全仓 6638 项。
6. ✅ `browser-agent/agent/README.md` 说明默认 dispose 与 `pagehide` 的恢复关闭调用；但其中“persists ... then releases”在 recovery driver 失败时并不成立，需随 Critical 修复校正或由实现兑现。

阻断项修复并补齐上述重建/隔离证据后再复审。
