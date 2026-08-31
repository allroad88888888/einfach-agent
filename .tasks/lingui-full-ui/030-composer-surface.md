---
id: "030"
title: 迁移消息输入面
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
  - apps/web/src/agentNew/ui/Composer.tsx
  - apps/web/src/agentNew/ui/ComposerAttachmentTray.tsx
  - apps/web/src/agentNew/ui/HistoryImageCompatibilityGuard.tsx
  - apps/web/src/agentNew/ui/UserImageAttachmentCard.tsx
---

# 迁移消息输入面

## 目标

让消息输入静态文案由 Lingui 渲染。

## 上下文

输入面包括发送/停止、授权模式、错误外壳、图片附件与历史图片不兼容提示。用户实际输入、图片文件名、
服务端错误 detail 和模型能力 reason 是数据，不翻译。不得变更 composer atom、提交行为或附件校验。

## 接口

### 消费

- Lingui React macros；050 提取并翻译新增 message。

### 产出

- 输入面固定按钮、placeholder、aria/title 与插值框架 message。

## 验收标准

1. `pnpm exec vitest run apps/web/src/agentNew/ui/Composer.test.tsx apps/web/src/agentNew/ui/Composer.images.test.tsx` → 通过。
2. `pnpm exec tsc -b` → 通过。
3. `git diff --check -- apps/web/src/agentNew/ui/Composer.tsx apps/web/src/agentNew/ui/ComposerAttachmentTray.tsx apps/web/src/agentNew/ui/HistoryImageCompatibilityGuard.tsx apps/web/src/agentNew/ui/UserImageAttachmentCard.tsx` → 无错误。

## 执行记录（仅编排者回写）

- 2026-08-21：执行完成，测试 Provider 缺口由 015 统一修补后再复验。
- 2026-08-21：015 后独立复验 29 个既有用例通过，审查 PASS。
