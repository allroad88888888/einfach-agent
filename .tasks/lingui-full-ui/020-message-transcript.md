---
id: "020"
title: 迁移消息转录壳
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
  - apps/web/src/agentNew/ui/MessageList.tsx
  - apps/web/src/agentNew/ui/MessageTimelineRenderer.tsx
  - apps/web/src/agentNew/ui/ToolActivity.tsx
  - apps/web/src/agentNew/ui/ThoughtTraceEntries.tsx
---

# 迁移消息转录壳

## 目标

让消息转录固定框架由 Lingui 渲染。

## 上下文

这四个文件承载空对话、生成状态、思考展开、撤回、工具活动、工具调用/结果框架。模型思考、消息正文、
工具名、参数和结果内容均为动态 payload，必须原样保留。不得改 timeline view model、运行状态或消息数据。

## 接口

### 消费

- Lingui React macros；050 从源码提取其消息。

### 产出

- 转录外壳静态文本、aria/title 和受控数值插值消息，供 050 翻译。

## 验收标准

1. `pnpm exec vitest run apps/web/src/agentNew/ui/MessageList.test.tsx apps/web/src/agentNew/ui/MessageList.timeline.test.tsx apps/web/src/agentNew/ui/ToolActivity.test.tsx` → 通过。
2. `pnpm exec tsc -b` → 通过。
3. `git diff --check -- apps/web/src/agentNew/ui/MessageList.tsx apps/web/src/agentNew/ui/MessageTimelineRenderer.tsx apps/web/src/agentNew/ui/ToolActivity.tsx apps/web/src/agentNew/ui/ThoughtTraceEntries.tsx` → 无错误。

## 执行记录（仅编排者回写）

- 2026-08-21：执行完成，测试 Provider 缺口由 015 统一修补后再复验。
- 2026-08-21：015 后独立复验 16 个既有用例通过，审查 PASS。
