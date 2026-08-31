---
id: "150"
title: 收口全界面双语交付
kind: leaf
parent: "300"
depends_on: ["120"]
discovered_from: "130,140"
model: gpt-5.6-sol
status: completed
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/i18n/locales/**
  - apps/web/src/agentNew/ui/i18nFullSurface.test.tsx
---

# 收口全界面双语交付

## 目标

完成次级时间线译文并验收全界面的中英文切换。

## 上下文

120 已迁移时间线静态文案；本叶合并原 130 catalog 与 140 审计，避免继续拆成细粒度工作。保留前 325 条
译文，只提取/翻译 120 的新静态 message。新增一个真实 locale 终验：English 下关键导航、聊天、输入、决策、
模型、MCP、插件、skills 和时间线固定框架为英文；动态 payload 原样。不可修改产品源文件。

## 验收标准

1. `pnpm lingui:extract --clean && pnpm lingui:compile` → English Missing 0。
2. `pnpm exec vitest run apps/web/src/agentNew/ui/i18nFullSurface.test.tsx` → 通过。
3. `pnpm build && pnpm check:state && pnpm check:boundaries` → 通过。
4. `git diff --check -- apps/web/src/i18n/locales apps/web/src/agentNew/ui/i18nFullSurface.test.tsx` → 无错误。

## 执行记录（仅编排者回写）

- 2026-08-21：根据用户反馈，原 130 与 140 合并为一个最终交付叶；不再拆分剩余工作。
- 2026-08-21：364 条 catalog、真实全界面 locale 回归、build/state/boundaries 均通过。
