# 055 执行报告：模型控件翻译目录

## 变更

仅更新了两份实际目录中的 PO：

- `apps/web/src/i18n/locales/en/messages.po`
- `apps/web/src/i18n/locales/zh-CN/messages.po`

本功能新增的 5 条英文文案已补齐：Thinking settings、Built-in models、Current model、当前模型不支持 Thinking、当前模型的 Thinking 能力未知对应的自然英文。中文源目录保持原文；未修改组件、Lingui 配置或其它产品文件。

## 验证

- `pnpm lingui:extract --clean`：通过，English Missing `0`（483 条）。
- `pnpm lingui:compile`：通过。
- `pnpm exec vitest run apps/web/src/agentNew/ui/i18nConversation.test.tsx`：通过，2 tests passed。
- `git diff --check`：通过。
- `pnpm exec lingui status`：未执行成功；当前安装的 Lingui CLI 报 `unknown command 'status'`。抽取统计已确认 English Missing `0`。
