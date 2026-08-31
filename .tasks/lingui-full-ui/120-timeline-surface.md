---
id: "120"
title: 迁移时间线固定框架
kind: leaf
parent: "300"
depends_on: ["110"]
discovered_from: null
model: gpt-5.6-sol
status: completed
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/agentNew/ui/BrowserActionCard.tsx
  - apps/web/src/agentNew/ui/BrowserCardTimelineRenderer.tsx
  - apps/web/src/agentNew/ui/CompletedPlanRecord.tsx
  - apps/web/src/agentNew/ui/RunDurationStatus.tsx
  - apps/web/src/agentNew/ui/SaveArtifact.tsx
  - apps/web/src/agentNew/ui/SubagentRunInline.tsx
  - apps/web/src/agentNew/ui/ThinkingTimelineRenderers.tsx
  - apps/web/src/agentNew/ui/TimelineItemView.tsx
---

# 迁移时间线固定框架

## 目标

让时间线固定框架由 Lingui 渲染。

## 上下文

这些 UI 的框架含浏览器动作、完成计划、耗时、保存产物、子 agent 和 thinking 状态。浏览器内容、文件名、
子 agent/工具输出、模型 payload 与 JSON preview 不翻译。不得改时间线 registry、存储或工具执行逻辑。

## 接口

### 消费

- Lingui macros；130 统一 catalog。

### 产出

- 次级时间线静态 UI message。

## 验收标准

1. `pnpm exec tsc -b` → 通过。
2. `git diff --check -- apps/web/src/agentNew/ui/BrowserActionCard.tsx apps/web/src/agentNew/ui/BrowserCardTimelineRenderer.tsx apps/web/src/agentNew/ui/CompletedPlanRecord.tsx apps/web/src/agentNew/ui/RunDurationStatus.tsx apps/web/src/agentNew/ui/SaveArtifact.tsx apps/web/src/agentNew/ui/SubagentRunInline.tsx apps/web/src/agentNew/ui/ThinkingTimelineRenderers.tsx apps/web/src/agentNew/ui/TimelineItemView.tsx` → 无错误。

## 执行记录（仅编排者回写）

- 2026-08-21：110 已通过独立 settings locale 回归，时间线迁移已派发。
- 2026-08-21：执行完成，TypeScript、scope 和行数检查通过，进入独立审查。
- 2026-08-21：用户要求收束任务；源码验收交由 150 的全界面终验覆盖。
