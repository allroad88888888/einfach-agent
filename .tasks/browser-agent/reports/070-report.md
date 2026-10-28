# 070 宿主关闭后恢复报告

状态：DONE（R1）

## 改动

- `BrowserAgentClient.dispose(options?: { preserveRecovery?: boolean })` 已实现。默认值与显式 `false` 继续调用 `stopRun`，运行落为 `stopped`；`true` 使用恢复关闭路径。
- 恢复关闭先将活动 `running` / `awaiting_tool` run 写成 `interrupted`，再取消该实例的提交、模型 signal 与执行图任务。等待用户、工具确认和计划确认的状态保持不变，排队输入不清空，也不走用户内容释放。
- 工具事实按已有 fence 保留：`notStarted` 不降级；已经是 `outcomeUnknown` 或缺少可靠事实的未配对调用保持/转为 unknown。因此外部写入不伪造回执、不自动重放，重建后继续得到 `reconciliation_required`。
- 修正旧循环迟到路径：abort error 只有 run 仍为 `running` 时才可写 `stopped`；host shutdown 后的 inactive 分支不再把 `notStarted` 改成 unknown；中断后的请求失败不再回写 context stats。
- client 等全部恢复快照与现有持久化队列 flush 完成后才 reset persistence 并释放 namespace owner。flush 失败会拒绝同一个 dispose promise，且不会提前释放 owner。
- 第一次 `dispose` 固定关闭方式；重复调用返回同一 Promise，不会再次停止或改写恢复状态。
- 新增 `browser-agent/agent/README.md`，说明默认关闭与 `pagehide` 使用的恢复关闭方式。

## R1 修复

- `interruptRunForRecovery` 不再丢弃 `RecoveryWriteOutcome`。配置了 recovery driver 时只有 `saved` 可以完成关闭交接；`error`、`skipped`、`tombstoned` 都会拒绝 dispose。未配置 recovery driver 的普通 core 继续沿用 no-op 兼容语义。
- dispose 拒绝后不会执行 persistence reset、listener 清理、disposed 标记或 owner release；第一次调用产生的拒绝 Promise 继续由所有重复 dispose 调用复用。
- 新增独立的 `hostCloseRecovery.integration.test.ts`，用真实 recovery driver 抛错，经 RecoveryWriter 形成 resolved `{status:'error'}`，验证 dispose 拒绝且同 namespace 第二 client 仍被 owner 拒绝。
- 补齐双 client pending fetch：关闭 A 只中断 A，B signal 未取消并正常完成，随后 A 同 namespace 重建并续跑完成。
- 补齐 fake IndexedDB 重建链：`waiting_confirmation` 的决策载荷原样恢复；未知外部写入重建后仍为 `reconciliation_required`，`continueRecoveredSession` 不触发模型请求或工具执行。

## 验证证据

- `pnpm exec vitest run browser-agent/agent/src`：6 files / 25 tests passed。R1 的真实 driver error outcome、双 client pending fetch、paused/unknown fake IndexedDB 重建均在其中。
- `pnpm exec vitest run packages/agent-core/src/runtime/commands/runInterruption.test.ts packages/agent-core/src/runtime/modelRun.toolLoopInterruption.test.ts packages/agent-core/src/runtime/modelRunLifecycle.recovery.test.ts packages/agent-core/src/runtime/compactMainContext.recovery.test.ts packages/agent-core/src/runtime/timedDispatch.recovery.test.ts packages/agent-core/src/runtime/timedDispatch.turnEnd.recovery.test.ts packages/agent-core/src/runtime/timedDispatch.stopRace.test.ts packages/agent-core/src/runtime/recoveryToolSafety.integration.test.ts packages/agent-core/src/runtime/commands/recoveryCommands.continue.test.ts`：9 files / 71 tests passed。
- 新增真实 `createBrowserAgent` + fake IndexedDB + 可控 pending fetch 用例：signal 被取消；同 namespace 立即重建；状态为 `recoverable`；`continueRecoveredSession` 完成第二次真实请求；忽略 signal 的旧 fetch 迟到响应未写回。
- 新增默认 dispose 用例：重建后为 `stopped` / `nonrecoverable`。
- 新增 core 用例：`notStarted` 与 unknown 工具事实分别保留；unknown 外部工具得到 `reconciliation_required`；`waiting_user` / `waiting_confirmation` / `waiting_plan_approval` 保持。
- `pnpm --filter @einfach-agent/core build`：passed。
- `pnpm --filter @einfach-agent/browser-agent build`：passed，包含声明文件检查。
- `pnpm check:state`：passed（1055 个非测试 TS/TSX）。
- `pnpm check:boundaries`：passed（1060 个非测试 TS/TSX）。
- `node scripts/check-docs.js`：passed（545 Markdown files）。
- `pnpm check:dist`：passed（22 packages / 32 public ESM entry points）。
- `git diff --check`：passed。

首次交付时一次将 agent 与多个 core 定向文件并行放入同一 Vitest invocation，既有动态 plugin import 出现一次 `defaultCorePlugins is not iterable`，同时一个原有 30ms 等待用例少收到一次请求。R1 仍按包分别执行，agent 25/25 与 core 恢复集 71/71 通过；没有未经证据声称该组合装载竞态已解决。

## 未完成项

- 按任务边界未启动浏览器、未修改 extension。编排通知 050 R1 的真实 Chrome 成功合同已经通过；本轮仅修复失败交接且未重跑浏览器。
- 未运行全仓 6638 项；按任务要求使用 agent 全集、恢复风险定向集和结构/分发门禁验收。
