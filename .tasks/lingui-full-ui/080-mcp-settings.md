---
id: "080"
title: 迁移 MCP 设置面
kind: leaf
parent: "200"
depends_on: ["060"]
discovered_from: null
model: gpt-5.6-sol
status: completed
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/agentNew/ui/McpSettingsPanel.tsx
  - apps/web/src/agentNew/ui/McpServerCard.tsx
  - apps/web/src/agentNew/ui/McpAddServerForm.tsx
  - apps/web/src/agentNew/ui/McpCredentialField.tsx
  - apps/web/src/agentNew/ui/McpLaunchConsentPrompt.tsx
  - apps/web/src/agentNew/ui/McpServerToolSummary.tsx
---

# 迁移 MCP 设置面

## 目标

让 MCP 设置静态文案由 Lingui 渲染。

## 上下文

迁移面板、服务器卡、表单、凭据字段、启动确认和工具摘要的固定 UI。MCP server name、URL、headers/env
键值、命令、诊断内容和探测结果是数据；不得改变表单校验、连接、持久化或启动确认安全逻辑。

## 接口

### 消费

- Lingui macros；100 catalog 收口。

### 产出

- MCP 设置固定 UI message 与受控插值框架。

## 验收标准

1. `pnpm exec vitest run apps/web/src/agentNew/ui/McpServerCard.test.tsx apps/web/src/agentNew/ui/SettingsCenter.mcp.test.tsx` → 通过。
2. `pnpm exec tsc -b` → 通过。
3. `git diff --check -- apps/web/src/agentNew/ui/McpSettingsPanel.tsx apps/web/src/agentNew/ui/McpServerCard.tsx apps/web/src/agentNew/ui/McpAddServerForm.tsx apps/web/src/agentNew/ui/McpCredentialField.tsx apps/web/src/agentNew/ui/McpLaunchConsentPrompt.tsx apps/web/src/agentNew/ui/McpServerToolSummary.tsx` → 无错误。

## 执行记录（仅编排者回写）

- 2026-08-21：060 已通过独立 English 回归，MCP 设置迁移已派发。
- 2026-08-21：执行完成，19 个专项用例通过，进入独立审查。
- 2026-08-21：独立审查 PASS；19 个专项用例、scope 和行数检查通过。
