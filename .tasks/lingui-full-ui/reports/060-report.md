# 060 对话 English 回归报告

## 实现与断言层面

- 新增 `apps/web/src/agentNew/ui/i18nConversation.test.tsx`，使用现有 `renderWithStore` 的生产同构装配，因此真实经过 `AppI18nProvider`、`appI18n` 和 Einfach 三层 store Provider。
- locale 切换直接调用真实 `activateLocale('zh-CN' | 'en')`，加载现有 compiled catalog；未 mock Lingui macro、`i18n._`、catalog 或 runtime command。
- 使用独立 root store 播种一条真实会话元数据，使用独立 agent store 播种一条带 reasoning/tool call 的 assistant 消息及 `waiting_confirmation` 工具确认状态。
- 中文初始回归断言：`appI18n.locale`、document language、会话删除、思考过程/模型思考、消息输入、发送、需要确认和允许。
- English 回归断言：
  - 会话导航：`Delete`、进入改名态后的 `Rename conversation`；
  - 消息/思考：`Reasoning`、`Model reasoning`；
  - Composer：`Message`、`Approval mode: Confirm`、`Send`；
  - 工具决策卡：`Confirmation required`、`About to run tool`、`Tool argument preview`、session 一律允许、`Reject`、`Allow`。
- 会话标题、模型 reasoning、工具名称和参数仅作为真实动态 fixture 输入，不作为翻译目标。
- 每例结束显式卸载 React 树、恢复 `appI18n` 为中文，并恢复进入用例前的 locale localStorage 项与 `document.documentElement.lang`，避免跨例泄漏。

## 验收结果

1. `pnpm exec vitest run apps/web/src/agentNew/ui/i18nConversation.test.tsx`
   - 通过：1 个测试文件，2/2 tests 通过。
2. `pnpm exec tsc -b`
   - 未通过，exit code 2；输出未包含 `i18nConversation.test.tsx`。
   - 阻塞均来自任务外 ModelConnection 在途漂移：`ModelConnectionProfileSettings.tsx`、`ModelCredentialPanel.connections.test.tsx`、`SettingsDialog.close.test.tsx` 与 `apps/web/src/settings/**` 的 `model`/`models` 类型不一致、host fixture 缺少 `probe`，以及 discovery source 字面量不匹配。
3. `git diff --check -- apps/web/src/agentNew/ui/i18nConversation.test.tsx`
   - 通过，无输出，exit code 0。
4. `wc -l apps/web/src/agentNew/ui/i18nConversation.test.tsx`
   - 135 行，低于普通文件 300 行上限；文件仅负责真实 catalog 下的对话中英文回归。

## 范围

- 未修改产品源码、PO、compiled catalog、task 文档或其他测试。
- 除本报告外，仅新增任务指定的 `i18nConversation.test.tsx`。

## R1：动态 fixture 原文边界

- 在 English 用例中补充动态内容保持原文的显式断言：模型 reasoning `Fixture reasoning supplied by the model.`、消息工具名 `fixture_read`、确认卡工具名 `fixture_write`、工具参数路径 `fixture.txt`。
- 保留既有 `Release notes fixture` 会话标题定位与改名交互断言；这些动态值不经过翻译，固定 UI 框架仍由真实 English catalog 提供。
- 未新增 mock，真实 `AppI18nProvider` / `appI18n` / `activateLocale` 路径及每例 locale、localStorage、document language 清理保持不变。

### R1 复验

1. `pnpm exec vitest run apps/web/src/agentNew/ui/i18nConversation.test.tsx`
   - 通过：1 个测试文件，2/2 tests 通过。
2. `pnpm exec tsc -b`
   - 未通过，exit code 2；输出未包含 `i18nConversation.test.tsx`。
   - 任务外错误仍为 ModelConnection `model`/`models` 契约不一致、host fixture 缺少 `probe`，以及 discovery source `manual`/`discovered` 字面量不匹配。
3. `git diff --check -- apps/web/src/agentNew/ui/i18nConversation.test.tsx`
   - 通过，无输出，exit code 0。
4. `wc -l apps/web/src/agentNew/ui/i18nConversation.test.tsx`
   - 138 行，低于 300 行上限，单一职责不变。
