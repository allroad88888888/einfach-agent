# 310：对话移除重做，保留撤销回填

浏览器对话已移除重做入口、已撤销消息占位和相关样式。撤销仍会停止当前运行（如有需要）、精确回填原始用户消息，并在输入框可用后聚焦；不可逆边界、恢复运行和会话隔离保持不变。

`ConversationTimeline` 现在只渲染真实 timeline 条目，因此全部撤销后显示空态。已更新既有回归：确认撤销消息不会渲染、没有重做入口；覆盖精确回填、运行中撤销焦点、相同文字连续撤销焦点，以及拒绝撤销时保留草稿。测试文件更名为 `undoComposer.test.tsx`。

验证通过：

- `pnpm exec vitest run browser-agent/ui/src/`（8 files / 30 tests）
- `pnpm --filter @einfach-agent/browser-agent-ui build`
- `pnpm --filter @einfach-agent/browser-extension build`
- `pnpm exec tsc -b`
- `git diff --check`
