# 050 R1 最终独立复审

结论：**PASSED**

本轮只读复核任务说明、全局 index、`050-report.md`、`050-scope-r1.diff`、050 对 070 合同的生产接入，以及更新后的真实浏览器证据。按要求未重跑测试或浏览器。前一轮已经关闭的 I1、I2、M1 与初始化错误面不重复审查。

## 最终缺口核实

### pagehide 消费 070 公共合同

✅ `browser-agent/extension/src/sidepanel.tsx:32` 在 side panel 的 `pagehide` 上调用公开的 `client.dispose({ preserveRecovery: true })`，且监听器为 `{ once: true }`。050 没有绕过 agent/core 写 IndexedDB，也没有复制恢复状态机；正常测试清理仍使用默认 `dispose()`，保留“默认 dispose 停止运行”的既有语义。

### 真实 pending run 关闭、重开与继续

✅ `browser-agent/extension/tests/browser-e2e.mjs` 先通过默认 UI 完成既有成功闭环，再创建新会话并发送第二条消息。CDP Fetch handler 在 `hold=true` 时故意保留该模型请求，`startPendingRun()` 等到请求确实进入挂起状态后才允许关闭 panel（`:145-150,187-193`），因此这里验证的是未完成 run，而不是完成态 client 重建。

✅ 关闭旧 panel 后，脚本等待 `sidePanel.onClosed/onOpened` 生命周期并要求重新出现一个不同 target id 的 `sidepanel.html`（`:78-83`），证明检查对象是新建的真实 side panel 上下文。

✅ 新 panel 枚举持久化 session，定位显示“可恢复上次运行”的会话，并同时要求目标栏包含原 `Controlled fixture`（`:86-98`）。这分别验证 core 恢复入口与 session→页面绑定恢复，而不是只看到旧 UI 文本。

✅ 脚本点击“恢复运行”，由新 panel 上的确定性模型请求返回 `Recovered safely.`，随后同时等待消息出现和 run strip 变为“已完成”（`:84-101`）。这证明恢复后能够安全继续，而不只是恢复按钮可见。

✅ 更新后的 `050-evidence/mv3-report.json` 保存：

- `panelOpened: true`、`panelClosed: true`、`panelOpenCount: 2`；
- `panelTargetClosed: true`；
- `defaultUi.flow.interruptedRecovery.recoverable: true`；
- `bindingRestored: true`；
- `continued: true`。

最终 harness 的成功条件显式要求 `interruptedRecovery.continued`，缺少该闭环会令脚本失败（`browser-e2e.mjs:119`）。报告准确区分了运行中恢复与此前的完成态重建证据。

## 问题分级

未发现新的 Critical、Important 或 Minor 问题。050 自身的 R1 验收项已满足。

## 全树状态说明

本结论只表示 **050 自身 PASSED**。070 当前仍在处理 preserve-recovery 保存失败的 outcome，并尚未取得独立 PASSED；依赖门要求全树及 050 的 `done` 状态继续等待 070 独立复审通过。该外部依赖不否定 050 对正常成功合同的正确消费及本轮真实浏览器证据。
