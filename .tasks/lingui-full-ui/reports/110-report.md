未派发。
# 110 设置国际化回归报告

## 完成范围

- 新增 `apps/web/src/agentNew/ui/i18nSettings.test.tsx`，使用真实 `AppI18nProvider`、`appI18n`、`activateLocale` 与 compiled PO catalog；未 mock Lingui macro 或 i18n runtime。
- 以最小真实 state/provider fixture 覆盖中文默认与显式 English：设置入口、模型凭据/端点表单与动作、MCP 表单/服务器/stdio 启动确认动作、插件与 Project Skills 固定文案。
- English 用例锁定 credential、endpoint URL、MCP server name/command/cwd/env name、plugin/skill name、tool name、description 与 diagnostics 原文不被翻译。
- 每个用例均清理渲染与设置状态，并精确恢复进入用例前的 `appI18n.locale`、`localStorage` locale preference 和 `document.documentElement.lang`；显式激活 English 后，`renderWithStore` 的默认 store 未把 locale 覆盖回中文。
- 未修改产品源码、PO、compiled catalog、任务定义或 index。

## 验证

- `pnpm exec vitest run apps/web/src/agentNew/ui/i18nSettings.test.tsx`：通过，1 file / 2 tests。
- `pnpm exec tsc -b --pretty false`：通过，无诊断；此前报告中的外部 ModelConnection 类型错误在当前工作树已不存在。
- `git diff --check -- apps/web/src/agentNew/ui/i18nSettings.test.tsx .tasks/lingui-full-ui/reports/110-report.md`：通过，无输出。
- 新文件未跟踪，额外执行 `git diff --no-index --check -- /dev/null apps/web/src/agentNew/ui/i18nSettings.test.tsx`：仅因存在新增 diff 返回 1，无 whitespace diagnostics。
- `wc -l apps/web/src/agentNew/ui/i18nSettings.test.tsx`：271 行，低于 300 行上限，文件仅负责设置国际化回归。
- scoped status：仅 `apps/web/src/agentNew/ui/i18nSettings.test.tsx` 与本报告为新增未跟踪文件。
