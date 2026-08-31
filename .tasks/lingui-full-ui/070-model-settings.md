---
id: "070"
title: 迁移模型设置面
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
  - apps/web/src/agentNew/ui/SettingsCenter.tsx
  - apps/web/src/agentNew/ui/StartupCredentialGate.tsx
  - apps/web/src/agentNew/ui/ModelCredentialPanel.tsx
  - apps/web/src/agentNew/ui/ModelCredentialCard.tsx
  - apps/web/src/agentNew/ui/ModelCredentialGroups.tsx
  - apps/web/src/agentNew/ui/ModelEndpointCard.tsx
---

# 迁移模型设置面

## 目标

让模型设置静态文案由 Lingui 渲染。

## 上下文

不触碰 `ModelConnectionProfile*`：这些文件是用户在途改动，仍单独 gated。Provider 名、credential label、
endpoint URL、用户 Key 和服务端错误是数据。迁移设置入口、启动门禁、凭据/端点固定说明、动作和 aria。

## 接口

### 消费

- Lingui React macros；100 统一提取/翻译本波 message。

### 产出

- 模型设置固定 UI message，不改变 credential/endpoint state 与网络行为。

## 验收标准

1. `pnpm exec vitest run apps/web/src/agentNew/ui/SettingsCenter.test.tsx apps/web/src/agentNew/ui/StartupCredentialGate.test.tsx` → 通过。
2. `pnpm exec tsc -b` → 通过。
3. `git diff --check -- apps/web/src/agentNew/ui/SettingsCenter.tsx apps/web/src/agentNew/ui/StartupCredentialGate.tsx apps/web/src/agentNew/ui/ModelCredentialPanel.tsx apps/web/src/agentNew/ui/ModelCredentialCard.tsx apps/web/src/agentNew/ui/ModelCredentialGroups.tsx apps/web/src/agentNew/ui/ModelEndpointCard.tsx` → 无错误。

## 执行记录（仅编排者回写）

- 2026-08-21：060 已通过独立 English 回归，模型设置迁移已派发。
- 2026-08-21：执行完成，12 个专项用例通过，进入独立审查。
- 2026-08-21：独立审查 PASS；12 个专项用例、scope 和行数检查通过。
