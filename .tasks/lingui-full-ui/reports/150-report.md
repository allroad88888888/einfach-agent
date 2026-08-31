# 150 全界面双语交付报告

## 完成范围

- 保留既有 325 条 English 译文；`extract --clean` 提取 120 时间线的 39 条新 message，全部补齐自然 English，catalog 现为 364 条、Missing 0。
- 新 count 框架使用 ICU plural：工具调用数、节点数、字符数、完成阶段数；终验实际断言 `1/1 stage complete`、`2 nodes`、`9 characters`。
- 重新编译 `en` / `zh-CN` catalog，产出各自的 `messages.po` 与 `messages.js`。
- 新增 211 行、单一职责的 `i18nFullSurface.test.tsx`，未 mock i18n 或 macro；通过 `renderWithStore` 中的生产同构 `AppI18nProvider` 加载真实编译 catalog。
- 中文与激活 English 均覆盖代表性导航、聊天/输入、执行决策、模型、MCP、插件、Skills 与时间线固定框架。浏览器 title/body、文件名、子 agent 目标、工具名、模型 reasoning、JSON path、workspace/session/skill 名均断言保持原样。
- 每个用例均清理 React 树，恢复 `appI18n`、locale localStorage 与 `html lang`；无跨例泄漏。

## 验证

- `pnpm lingui:extract --clean && pnpm lingui:compile`：通过；`zh-CN 364`，`en 364 / Missing 0`。
- `pnpm exec vitest run apps/web/src/agentNew/ui/i18nFullSurface.test.tsx`：通过，1 个测试文件、2 个用例。
- `pnpm build && pnpm check:state && pnpm check:boundaries`：通过。Vite 仅输出已有的混合导入与大 chunk 非阻断警告；边界检查仅输出已豁免观察项。
- `git diff --check -- apps/web/src/i18n/locales apps/web/src/agentNew/ui/i18nFullSurface.test.tsx`：通过，无输出。
- `wc -l apps/web/src/agentNew/ui/i18nFullSurface.test.tsx`：`211`，低于 300 行硬上限。

## 边界与 scoped diff

- 本叶仅修改 `apps/web/src/i18n/locales/**`、新增 `apps/web/src/agentNew/ui/i18nFullSurface.test.tsx` 并回写本报告；未修改产品源码、其他测试或 task 定义。
- 动态浏览器内容、文件名、子 agent/工具/模型内容与 JSON payload 未进入译文。
