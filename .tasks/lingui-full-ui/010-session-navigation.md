---
id: "010"
title: 迁移会话导航
kind: leaf
parent: "100"
depends_on: []
discovered_from: null
model: gpt-5.6-terra
status: completed
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/agentNew/ui/SessionList.tsx
  - apps/web/src/agentNew/ui/ActiveSessionProvider.tsx
  - apps/web/src/agentNew/ui/SessionList.test.tsx
  - apps/web/src/agentNew/ui/ActiveSessionProvider.test.tsx
---

# 迁移会话导航

## 目标

让会话导航静态文案由 Lingui 渲染。

## 上下文

`SessionList.tsx` 现含重命名、删除/确认删除等中文 aria/action 文案；`ActiveSessionProvider.tsx` 是无会话
空态。会话 title、workspace 名和用户输入是数据，不翻译。只改这两个组件；不写 PO、不改 session atom。

## 接口

### 消费

- `Trans` 与 `t`：现有 `@lingui/react/macro` 用法，catalog 由 050 提取。

### 产出

- 两个组件的所有静态可见/可访问会话文案成为 Lingui message，供 050 catalog 收口。

## 验收标准

1. `pnpm exec vitest run apps/web/src/agentNew/ui/SessionList.test.tsx apps/web/src/agentNew/ui/ActiveSessionProvider.test.tsx` → 通过。
2. `pnpm exec tsc -b` → 通过。
3. `git diff --check -- apps/web/src/agentNew/ui/SessionList.tsx apps/web/src/agentNew/ui/ActiveSessionProvider.tsx` → 无错误。

## 执行记录（仅编排者回写）

- 2026-08-21：执行完成，进入审查。执行报告发现既有测试缺 Lingui provider；测试文件已纳入 R1 范围。
- 2026-08-21：015 复验 20 个既有用例通过，独立审查 PASS。
