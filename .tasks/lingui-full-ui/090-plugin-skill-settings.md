---
id: "090"
title: 迁移插件技能设置面
kind: leaf
parent: "200"
depends_on: ["060"]
discovered_from: null
model: gpt-5.6-terra
status: completed
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/agentNew/ui/PluginSettingsPanel.tsx
  - apps/web/src/agentNew/ui/PluginEntryCard.tsx
  - apps/web/src/agentNew/ui/PluginToolToggleList.tsx
  - apps/web/src/agentNew/ui/ProjectSkillsPanel.tsx
---

# 迁移插件技能设置面

## 目标

让插件技能设置静态文案由 Lingui 渲染。

## 上下文

插件名称、描述、诊断文字、skill name、source path 和资源文件名是数据；不得翻译。迁移容器的固定警告、
空态、动作、状态、数量插值和 aria/title；不改插件加载、skill 扫描或 toggle store。

## 接口

### 消费

- Lingui macros；100 写本波 catalog。

### 产出

- 插件/skills 静态设置 UI message。

## 验收标准

1. `pnpm exec vitest run apps/web/src/agentNew/ui/PluginSettingsPanel.test.tsx apps/web/src/agentNew/ui/ProjectSkillsPanel.test.tsx` → 通过。
2. `pnpm exec tsc -b` → 通过。
3. `git diff --check -- apps/web/src/agentNew/ui/PluginSettingsPanel.tsx apps/web/src/agentNew/ui/PluginEntryCard.tsx apps/web/src/agentNew/ui/PluginToolToggleList.tsx apps/web/src/agentNew/ui/ProjectSkillsPanel.tsx` → 无错误。

## 执行记录（仅编排者回写）

- 2026-08-21：060 已通过独立 English 回归，插件技能设置迁移已派发。
- 2026-08-21：执行完成，11 个专项用例通过，进入独立审查。
- 2026-08-21：独立审查 PASS；11 个专项用例与 scope 检查通过。
