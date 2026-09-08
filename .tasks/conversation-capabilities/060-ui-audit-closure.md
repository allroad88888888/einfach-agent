---
id: "060"
title: 关闭 UI 与国际化缺口
kind: leaf
parent: "300"
depends_on: ["040"]
discovered_from: "040"
model: gpt-5.6-terra
status: done
created: 2026-09-08
base: 0fb3afbdf656df7184134075887aa414eb348828
files:
  - packages/agent-core/src/runtime/sessionCapabilityCatalog.ts
  - packages/agent-core/src/runtime/sessionCapabilityCatalog.test.ts
  - apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.tsx
  - apps/web/src/agentNew/ui/ConversationCapabilitySection.tsx
  - apps/web/src/agentNew/ui/ConversationCapabilitiesPanel.test.tsx
  - apps/web/src/agentNew/ui/AppShell.test.tsx
  - apps/web/src/i18n/locales/en/messages.po
  - apps/web/src/i18n/locales/en/messages.js
  - apps/web/src/i18n/locales/zh-CN/messages.po
  - apps/web/src/i18n/locales/zh-CN/messages.js
  - .tasks/conversation-capabilities/reports/060-report.md
---

# 关闭 UI 与国际化缺口

## 目标

修复 040 发现的英文 tombstone、异步目录乱序和 AppShell mock 回归，并补齐 loading/empty/focus 直接覆盖。

## 必须实现的语义

- Core catalog 的 unavailable tombstone 不再携带固定英文用户文案；只返回稳定结构/空描述。展示层根据
  `available=false` 使用 Lingui 渲染“此能力在当前环境中已不可用”等说明，动态正常描述仍原样显示。
- 中文真实 Provider 测试必须断言 tombstone 说明为中文且无那句英文；English catalog 同样完整。
- Panel `load()` 加 request generation 或取消守卫。sessionId/policyVersion/retry 引发的旧请求晚返回时，
  不得覆盖最新 catalog/error/loading；关闭/切会话后也不得把旧数据重新写入当前面板。
- 直接测试首次 loading `role=status`、工具和 Skill 同时为空的两个空态、out-of-order 两次 load 的最终值。
- 直接测试 Tab 与 Shift+Tab 在 dialog 首尾 focusable 元素间环绕；保留 Escape 与触发按钮焦点归还。
- 同步 `AppShell.test.tsx` 的 commands mock，提供本功能渲染路径调用的稳定 catalog/命令；不得 mock 掉
  整个能力入口或弱化原 5 项断言。
- `pnpm lingui:extract`/`compile` 后 catalogs 稳定且 English Missing 0。

## 验收标准

1. 中文 UI 不再出现 tombstone 英文；unavailable 的可访问描述仍完整。
2. deferred promise 测试证明旧 load 无法覆盖新 load，loading/empty/focus 环均有直接断言。
3. `AppShell.test.tsx` 原 5 项与能力 UI 定向测试全绿。
4. extract/compile 稳定，相关 Vitest、`pnpm exec tsc -b --pretty false`、`git diff --check`、行数门全绿。
5. 写 `reports/060-report.md`；不得 commit，不得修改任务外文件。

## 执行记录（仅编排者回写）

- 2026-09-08：由 040 的 C-002/C-013/C-014/C-015 缺口发现。
- 2026-09-08：已派发执行。
- 2026-09-08：首轮独立复核发现 stale load 竞态；修复并补 deferred 回归后复核 APPROVED。编排者复跑 UI 3 files / 19 tests 通过，任务完成。
