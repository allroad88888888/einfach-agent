## 015 — 测试语言 Provider

### 变更

- `renderWithStore` 在没有已激活 locale 时同步载入真实 `zh-CN` catalog，再按生产层级挂载 `AppI18nProvider`。
- 保持 `renderWithStore(ui, options)` API 不变；已有显式激活的 English locale 不会被该默认初始化覆盖。
- 新增 helper 回归：验证真实 `useLingui` 与 `Trans` 可用，且默认回到中文；测试结束后恢复中文。

### 验收

- `pnpm exec vitest run apps/web/src/test/renderWithStore.test.tsx`：通过（1 file / 1 test）。
- `pnpm exec vitest run apps/web/src/agentNew/ui/SessionList.test.tsx apps/web/src/agentNew/ui/ActiveSessionProvider.test.tsx apps/web/src/agentNew/ui/Composer.test.tsx apps/web/src/agentNew/ui/Composer.images.test.tsx apps/web/src/agentNew/ui/MessageList.test.tsx apps/web/src/agentNew/ui/MessageList.timeline.test.tsx apps/web/src/agentNew/ui/ToolActivity.test.tsx`：通过（7 files / 65 tests）。
- `git diff --check -- apps/web/src/test/renderWithStore.tsx apps/web/src/test/renderWithStore.test.tsx`：通过，无错误。

### 行数与范围

- `renderWithStore.tsx`：63 行；`renderWithStore.test.tsx`：51 行，均低于 300 行。
- 任务范围外失败：无。

### R1 修复

- 修正 locale 对齐：helper 取得真实已激活的 `appI18n.locale`，并写入每次使用的 UI store（包括调用者传入的 store），所以 `AppI18nProvider` 不会把已激活的 English 回切成默认中文。
- 未激活时仍同步载入真实中文 catalog，保证同步 RTL 断言不会收到 Lingui 的空树。
- 回归现在分别断言同步中文和真实 English 文案/locale；每例结束后仍以 `activateLocale('zh-CN')` 恢复全局语言。
- R1 验收：helper 测试通过（1 file / 2 tests）；指定组件套件通过（7 files / 65 tests）；scoped `git diff --check` 通过。

### R2 修复

- 将 UI store 的 locale 对齐改为 `hydrateLocalePreference(store, storageStub)`；该路径直接写入 store，不调用会写入 `web-agent.locale.v1` 的持久化 setter。
- English 回归保留无 locale 的同步中文覆盖和预激活 English 覆盖；English 断言后卸载、重新挂载中文 Provider，并验证 `appI18n.locale`、`document.documentElement.lang` 为 `zh-CN` 且 locale localStorage 项保留原值。
- R2 验收：helper 测试通过（1 file / 2 tests）；指定组件套件通过（7 files / 65 tests）；scoped `git diff --check` 通过；两文件分别为 63、51 行。
