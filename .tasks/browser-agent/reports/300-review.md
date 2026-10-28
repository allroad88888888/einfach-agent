# 300 撤销回填与重做独立审查

## 结论

**PASSED**。未发现 Critical、Important 或 Minor 问题。290 的增量只在 UI 层补齐撤销回填、聚焦和原位重做语义，继续直接复用 core 的 `sessionTurnHistoryAtom`、`retractTurn` 与 `restoreRetractedTurn`；没有复制或持久化第二份历史。`290-delta.diff` 与保存的 `290-before/` 相符，本次增量为 `ChatView.tsx`、`ConversationTimeline.tsx`、两处既有测试按钮文案更新和独立真实 client 集成测试；`290-scope.diff` 中其余大范围变化属于动手前已有工作。

本审查按任务要求只读源码、diff、既有测试与 `290-browser-check.md`，没有重复运行 290 已报告为绿色的测试，也没有操作浏览器。

## 验收

- ✅ **U01 成功撤销精确回填、停止后聚焦、失败不改草稿。** `ChatView.tsx:47-61` 保留发送前的原字符串（仅以 `trim()` 判断空白），调用带显式 `sessionId` 的 `retractTurn` 后只在 `result.ok` 时从目标轮回填；字符串不裁剪，content parts 仅提取 `type: 'text'`。`ChatView.tsx:71-76` 以 `busy` 结束为条件聚焦 textarea；相同文本的连续撤销仍由 `focusWhenReady` 独立触发。真实 client 用例 `undoComposerRedo.test.tsx:34-45,65-85,87-126` 覆盖换行/Unicode、运行中 abort 后启用并聚焦、同文本再次聚焦及拒绝时保留草稿。原生 Chrome 证据也记录中间轮与全撤入口均精确回填并聚焦。
- ✅ **U02 消息原位多入口重做与已有结果恢复。** `ConversationTimeline.tsx:13-18,53-55` 在活动消息消失后仍从 turn-history projection 渲染每个 retracted turn，并为每轮提供原生 `button`“重做”；title 明确恢复已有结果且不重新执行模型、网页或业务操作。真实 client 用例 `undoComposerRedo.test.tsx:38-52` 验证全部撤销后保留两个入口、选择第二轮后恢复已有回复且模型请求计数保持 2。`BrowserAgentView.test.tsx:187-207` 延续显式展示会话的撤销、重做与恢复隔离。原生 Chrome 证据覆盖中间撤销多个入口、全撤入口仍在以及选定轮恢复。
- ✅ **U03 只清来源轮已恢复且未编辑的自动回填。** `ChatView.tsx:42,77-81,92` 只维护组件内临时 `refilledFrom`；textarea 的任何编辑立即解除关联，turn-history 投影确认该来源轮重新 active 时才清空。真实 client 用例 `undoComposerRedo.test.tsx:48-62` 同时证明未编辑回填会清空、编辑后草稿保留、重做未增加模型请求；重做入口在草稿编辑后仍存在。发送新消息仍走既有 core 分支路径，并在成功后清除临时来源（`ChatView.tsx:47-51`）。原生 Chrome 证据记录编辑多行草稿后重做全部轮次仍保留草稿。
- ✅ **U04 session/client 隔离与 settings 返回。** 所有历史命令均传入当前挂载 `Conversation` 的 `sessionId`（`ChatView.tsx:53-65`），会话切换依赖 keyed provider，不读取全局当前会话作为命令目标。`BrowserAgentView.test.tsx:187-207` 的真实双会话用例验证操作只影响展示会话；既有 `chat-first-layout.test.tsx:20-36` 验证进入 settings 再返回后选中会话和草稿保留。290 没有改变 client 切换和设置状态代码，范围 diff 中既有 client 隔离测试保持在位。

## 边界与验证证据

- `ConversationTimeline.tsx:45-50` 保留撤销对外部网页/业务副作用无效的既有说明；重做 title 也明确不重新执行这些操作。
- 新增 `undoComposerRedo.test.tsx` 为 137 行，`ChatView.tsx` 110 行，`ConversationTimeline.tsx` 61 行；未违反任务文件长度约束。
- 290 报告记录：UI 8 文件/30 用例、UI build、extension build、根 `tsc -b`、docs 检查均通过；`290-verification.md` 另记录 state/boundaries、embedded build、diff check、最终 dist 内容及 ZIP 逐字节/CRC 校验通过。原生 Chrome 编排证据覆盖 360px 本地 fixture 下的实际按钮、回填、焦点、多个入口与编辑草稿保留。安装中的扩展尚未重载，因此这些浏览器证据不冒充安装实例验证；交付时需提示用户重载扩展。上述均作为既有证据引用，本审查未冒充重新实测。

## 发现

无。
