---
id: "110"
title: 验证设置英文渲染
kind: leaf
parent: "200"
depends_on: ["100"]
discovered_from: null
model: gpt-5.6-sol
status: completed
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/agentNew/ui/i18nSettings.test.tsx
---

# 验证设置英文渲染

## 目标

验证设置面切换 English 后呈现英文。

## 上下文

使用真实 i18n provider 和最小的模型、MCP、插件、skills fixture。每个断言只检查固定 UI，不检查用户
credential、server name、URL、插件元数据或诊断 payload 的翻译。

## 接口

### 消费

- 100 compiled settings catalog。

### 产出

- 设置 English 回归测试，供 140 汇总。

## 验收标准

1. `pnpm exec vitest run apps/web/src/agentNew/ui/i18nSettings.test.tsx` → 通过，覆盖中文初始与 English 关键导航/表单/动作。
2. `pnpm exec tsc -b` → 通过。

## 执行记录（仅编排者回写）

- 2026-08-21：100 已通过独立 catalog 审查，真实设置 English 回归已派发。
- 2026-08-21：执行完成，2 个真实 locale 回归与 `tsc -b` 通过，进入独立审查。
- 2026-08-21：独立审查 PASS；真实 settings locale 回归与 TypeScript 检查通过。
