---
id: "040"
title: 迁移执行决策卡
kind: leaf
parent: "100"
depends_on: []
discovered_from: null
model: gpt-5.6-sol
status: completed
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/agentNew/ui/PlanPanel.tsx
  - apps/web/src/agentNew/ui/PlanStageExecutionTrace.tsx
  - apps/web/src/agentNew/ui/ToolConfirmCard.tsx
  - apps/web/src/agentNew/ui/AskUserQuestionCard.tsx
---

# 迁移执行决策卡

## 目标

让执行决策卡静态文案由 Lingui 渲染。

## 上下文

这些组件显示计划/阶段状态、工具确认与补充问题的 UI 框架。计划 title、stage title、风险说明、工具参数、
用户问题/选项和 block reason 属动态数据，保留原样。不得改变批准、拒绝、继续或回答命令。

## 接口

### 消费

- Lingui React macros；050 唯一写 PO。

### 产出

- 决策卡固定状态、动作、section title、aria 与插值框架 message。

## 验收标准

1. `pnpm exec vitest run apps/web/src/agentNew/ui/PlanPanel.test.tsx apps/web/src/agentNew/ui/PlanPanel.commandBoundary.test.tsx apps/web/src/agentNew/ui/ToolConfirmCard.test.tsx apps/web/src/agentNew/ui/AskUserQuestionCard.test.tsx` → 通过。
2. `pnpm exec tsc -b` → 通过。
3. `git diff --check -- apps/web/src/agentNew/ui/PlanPanel.tsx apps/web/src/agentNew/ui/PlanStageExecutionTrace.tsx apps/web/src/agentNew/ui/ToolConfirmCard.tsx apps/web/src/agentNew/ui/AskUserQuestionCard.tsx` → 无错误。

## 执行记录（仅编排者回写）

- 2026-08-21：执行完成，测试 Provider 缺口由 015 统一修补后再复验。
- 2026-08-21：独立审查发现 ToolConfirmCard 路径预览分隔符遗漏；原执行者进入 R1 修补。
- 2026-08-21：R1 经独立复审 PASS，28 个专项用例通过。
