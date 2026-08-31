# PASS

## R2 复审结论

015 已满足全部审查要求，无剩余问题。

## 关键证据

- `renderWithStore.tsx:12-17` 在 `appI18n` 尚无 locale 时，于 RTL `render` 之前用真实 `zh-CN/messages.po` 同步 `loadAndActivate`；默认用例同步看到 `zh-CN` 和“新建工作区”。
- `renderWithStore.tsx:36-38` 通过现有 `hydrateLocalePreference` 与内存型 `LocaleStorage` 将已激活 locale 对齐到 UI store；`hydrateLocalePreference` 直接写内部 value atom，不走会调用 `persistLocalePreference` 的公开 setter，因此不改真实 localStorage。
- `renderWithStore.test.tsx:33-41` 先 `await activateLocale('en')`，再在真实 `AppI18nProvider` 下断言 UI store atom 为 `en`、Lingui locale 为 `en`、真实 English catalog 文案为 `New workspace`；无 mock catalog/翻译函数。
- `renderWithStore.test.tsx:35,43-49` 保存原 localStorage 值，卸载 English Provider 后重新激活中文并重新挂载 Provider，显式断言 `appI18n.locale === 'zh-CN'`、`document.documentElement.lang === 'zh-CN'` 且 locale localStorage 原值未变；`afterEach` 也 await 恢复中文并恢复 HTML lang，无 locale 泄漏。
- `renderWithStore(ui, options)` 的签名、options 过滤与返回形状未变。三层 store 仍为 `Provider(store) -> RootStoreProvider(rootStore) -> AgentStoreProvider(agentStore)`，默认实例选择与嵌套语义未变；`AppI18nProvider` 仅插入 UI store 与 root store 之间。
- 单一职责合格：helper 只负责 RTL store/i18n 装配，测试文件只验证该装配。

## 独立验证

- `pnpm exec vitest run apps/web/src/test/renderWithStore.test.tsx` → PASS（1 file / 2 tests）。
- `pnpm exec vitest run apps/web/src/agentNew/ui/SessionList.test.tsx apps/web/src/agentNew/ui/ActiveSessionProvider.test.tsx apps/web/src/agentNew/ui/Composer.test.tsx apps/web/src/agentNew/ui/Composer.images.test.tsx apps/web/src/agentNew/ui/MessageList.test.tsx apps/web/src/agentNew/ui/MessageList.timeline.test.tsx apps/web/src/agentNew/ui/ToolActivity.test.tsx` → PASS（7 files / 65 tests）。
- `git diff --check -- apps/web/src/test/renderWithStore.tsx apps/web/src/test/renderWithStore.test.tsx` → PASS（exit 0）。
- `wc -l apps/web/src/test/renderWithStore.tsx apps/web/src/test/renderWithStore.test.tsx` → 63 / 51，均 ≤ 300。
