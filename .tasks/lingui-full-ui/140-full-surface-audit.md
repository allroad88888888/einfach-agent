---
id: "140"
title: 审计全界面翻译覆盖
kind: leaf
parent: "300"
depends_on: ["060", "110", "130"]
discovered_from: null
model: gpt-5.6-sol
status: merged_into_150
created: 2026-08-21
done: null
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/agentNew/ui/i18nFullSurface.test.tsx
---

# 审计全界面翻译覆盖

## 目标

审计 English 下的全界面静态文案。

## 上下文

060/110 已有分区回归，130 已冻结最后 catalog。本测试从 AppShell 和代表性设置/时间线组件启动真实 provider，
在 English 下断言关键 navigation、聊天、输入、决策、模型、MCP、插件、skills 与时间线框架为英文；允许动态
payload 原样出现。测试应同时扫描 `apps/web/src/agentNew/ui` 的 production JSX 静态中文候选并维护显式允许表，
允许表只能包含动态 payload 生成位置并附理由。

## 接口

### 消费

- 060/110 regression 与 130 compiled catalog。

### 产出

- 端到端 English 覆盖审计与动态数据允许表。

## 验收标准

1. `pnpm exec vitest run apps/web/src/agentNew/ui/i18nFullSurface.test.tsx` → 通过，English key UI 无未批准中文静态文案。
2. `pnpm build && pnpm check:state && pnpm check:boundaries` → 通过。
3. `git diff --check -- apps/web/src/agentNew/ui/i18nFullSurface.test.tsx` → 无错误。

## 执行记录（仅编排者回写）

- 2026-08-21：合并到 150 最终双语交付，避免继续细分。
