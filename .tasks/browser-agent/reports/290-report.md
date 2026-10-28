# 290 撤销回填与原位重做

## 实际文件

- `browser-agent/ui/src/chat/ChatView.tsx`
- `browser-agent/ui/src/chat/ConversationTimeline.tsx`
- `browser-agent/ui/src/chat/messageHistoryActions.test.tsx`
- `browser-agent/ui/src/chat/undoComposerRedo.test.tsx`
- `browser-agent/ui/src/BrowserAgentView.test.tsx`

前态保存在 `.tasks/browser-agent/reports/290-before/`，相对 HEAD 的动手前差异保存在 `.tasks/browser-agent/reports/290-prechange.diff`；本执行单元的补充副本分别为 `290-agent-before/` 与 `290-agent-prechange.diff`。未修改 core、extension 权限或打包隔离。

## 根因与行为

core 的轮次事务日志、`retractTurn`、`restoreRetractedTurn` 和 `sessionTurnHistoryAtom` 已保留完整 redo 尾部。缺口位于 UI：撤销成功后只显示反馈，没有把所选用户消息写回 composer；已撤销消息的入口仍叫“恢复至本轮”；composer 也不知道自动回填来自哪一轮，因而无法在重做时安全判断是否清空。

现在仅在挂载中的 `Conversation` 维护一次临时自动回填来源。撤销成功后从该用户消息提取原字符串；结构化内容只拼接 `type: 'text'` 的正文，不序列化图片或元数据。textarea 在运行停止并恢复可用后获得焦点。撤销失败时不改草稿。

每条已撤销消息原位显示可键盘触发的“重做”，标题说明会恢复已有结果且不会重跑模型或外部操作。重做继续直接调用 core 的 `restoreRetractedTurn`。只有自动回填仍未被编辑、且其来源轮已恢复时才清空；任何 textarea 编辑都会解除自动回填关联，所以用户草稿保留。仅编辑草稿不会截断 redo，发送新消息仍由 core 建立新分支。

新增真实 browser client 集成覆盖：多轮撤销后保留多个入口、换行与 Unicode 原文回填和聚焦、恢复既有 assistant 结果时模型请求数不增加、编辑后的草稿在重做后保留；运行中的真实请求被撤销时先中止，再启用、回填并聚焦 textarea；连续两条相同文本通过真实点击让按钮夺焦，验证第二次撤销即使 draft 值不变也会重新聚焦；撤销命令拒绝时保留原草稿。既有真实双会话用例继续验证命令只作用于当前展示会话。

## 验证

- `pnpm exec vitest run browser-agent/ui/src/`：通过，8 个文件、30 个用例。
- `pnpm --filter @einfach-agent/browser-agent-ui build`：通过。
- `pnpm --filter @einfach-agent/browser-extension build`：通过；IIFE/现有权限相关配置未改。
- `pnpm exec tsc -b`：通过。
- `node scripts/check-docs.js`：通过，657 个 Markdown 文件。
- 文件行数：`ChatView.tsx` 110 行，`ConversationTimeline.tsx` 61 行，新增集成测试 137 行，均低于普通文件 300 行限制。
- core 未改，因此未重复运行 core 历史测试。

## 遗留

无已知遗留。原生 Chrome QA 由编排继续执行。
