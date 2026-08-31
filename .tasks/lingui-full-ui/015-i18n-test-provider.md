---
id: "015"
title: 补齐测试语言 Provider
kind: leaf
parent: "100"
depends_on: []
discovered_from: "010,020,030"
model: gpt-5.6-terra
status: completed
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/test/renderWithStore.tsx
  - apps/web/src/test/renderWithStore.test.tsx
---

# 补齐测试语言 Provider

## 目标

让 `renderWithStore` 提供可用的 Lingui 语言上下文。

## 上下文

010、020、030 将静态文案迁移到 `useLingui()` / `Trans` 后，既有组件测试统一因缺少
`I18nProvider` 而崩溃。生产入口已经使用 `AppI18nProvider`；此叶只让公共 RTL helper
按生产装配它。默认测试语言保持中文，不能用 mock 翻译函数或在测试中引入产品级 React state。

## 接口

### 消费

- `AppI18nProvider`、`activateLocale` 与 `appI18n`：现有 `apps/web/src/i18n` 边界。

### 产出

- 既有 `renderWithStore(ui, options)` 签名不变，所有经其渲染的 Lingui 组件都有真实 Provider。

## 验收标准

1. `pnpm exec vitest run apps/web/src/test/renderWithStore.test.tsx` → 通过。
2. `pnpm exec vitest run apps/web/src/agentNew/ui/SessionList.test.tsx apps/web/src/agentNew/ui/ActiveSessionProvider.test.tsx apps/web/src/agentNew/ui/Composer.test.tsx apps/web/src/agentNew/ui/Composer.images.test.tsx apps/web/src/agentNew/ui/MessageList.test.tsx apps/web/src/agentNew/ui/MessageList.timeline.test.tsx apps/web/src/agentNew/ui/ToolActivity.test.tsx` → 通过。
3. `git diff --check -- apps/web/src/test/renderWithStore.tsx apps/web/src/test/renderWithStore.test.tsx` → 无错误。

## 执行记录（仅编排者回写）

- 2026-08-21：010、020、030 的执行报告共同发现此共享缺口；本叶只修测试装配，不改产品运行时。
- 2026-08-21：执行完成，1 个 helper 用例与 65 个既有组件用例通过，进入独立审查。
- 2026-08-21：审查发现预先激活的 English 被测试 store 默认语言覆写；原执行者进入 R1。
- 2026-08-21：R1 保留 English 已通过，但审查发现持久化/DOM 语言副作用泄漏；原执行者进入 R2。
- 2026-08-21：R2 经独立复审 PASS；默认中文、预激活 English 与所有 locale 副作用清理均已验证。
