---
id: "060"
title: 验证对话英文渲染
kind: leaf
parent: "100"
depends_on: ["050"]
discovered_from: null
model: gpt-5.6-sol
status: completed
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/agentNew/ui/i18nConversation.test.tsx
---

# 验证对话英文渲染

## 目标

验证聊天主线切换 English 后呈现英文。

## 上下文

使用 `AppI18nProvider`、`appI18n`、`activateLocale` 的现有 i18n 边界。测试需给会话、消息、输入、决策卡
提供最小真实数据，断言 English 固定 UI 文案与中文初始回归；不得 mock macro 或 `i18n._`。

## 接口

### 消费

- 050 compiled English catalog。

### 产出

- 单一对话 i18n 回归测试，供 140 汇总审计。

## 验收标准

1. `pnpm exec vitest run apps/web/src/agentNew/ui/i18nConversation.test.tsx` → 通过，包含中文初始与 English 断言。
2. `pnpm exec tsc -b` → 通过。
3. `git diff --check -- apps/web/src/agentNew/ui/i18nConversation.test.tsx` → 无错误。

## 执行记录（仅编排者回写）

- 2026-08-21：050 已通过独立审查，真实 English 回归已派发。
- 2026-08-21：执行完成，2 个真实 locale 回归通过，进入独立审查。
- 2026-08-21：审查要求锁住动态模型/工具 fixture 不翻译的边界；原执行者进入 R1。
- 2026-08-21：R1 经独立复审 PASS；固定英文与动态原文边界均有真实 catalog 回归。
