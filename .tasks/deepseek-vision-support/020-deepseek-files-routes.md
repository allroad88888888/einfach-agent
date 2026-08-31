---
id: 020
title: 开放 DeepSeek 文件传输端点
kind: leaf
parent: 100
depends_on: []
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/modelTransport/providerRoute.ts
  - apps/web/src/modelTransport/providerRoute.test.ts
  - packages/host-node/src/model/providerRoute.ts
  - packages/host-node/src/model/providerRoute*.ts
  - packages/host-node/src/model/*.test.ts
  - scripts/model-preview-relay-routes.ts
  - scripts/model-preview-relay-routes.test.ts
---

# 开放 DeepSeek 文件传输端点

## 目标

在浏览器传输判定、Node host 安全解析和开发 preview relay 三个真实入口一致开放 DeepSeek Files API，
且仅允许固定官方 origin 的 multipart `POST /files` 与匹配 `file-api-*` 的 `DELETE /files/{id}`。

## 粒度

预计 15–25 分钟；三个入口共同组成一个安全白名单交付，漏任一处都会让对应部署态不可用或策略漂移。
`packages/host-node/src/model/providerRoute.ts` 已接近 300 行，本次新增会越线，必须按“路由目录数据”与
“请求解析”职责拆分，不能申请复杂文件例外。

## 上下文

Kimi 已开放 `/files`，可参考它的方法、multipart body limit 与 DELETE 安全规则，但 DeepSeek 文件 ID
必须使用 `file-api-*`，不能接受 Kimi ID 或任意 path segment。现有 DeepSeek 只开放
`POST /chat/completions`。三处策略必须共享相同语义，即使实现无法直接共享模块。

新文件职责计划：
- `packages/host-node/src/model/providerRouteCatalog.ts` → 只声明受信 provider 路由和 origin 数据。
- 其余新增测试文件 → 每个只覆盖一个路由表面，避免大杂烩 fixture。

## 覆盖矩阵行

- `C-003`：browser、host-node、preview 三态文件路由白名单。

## 接口

### 消费
- `ProviderRouteRequest` / multipart size 常量：来自现有 provider route 实现。

### 产出
- DeepSeek route resolver 接受 `POST /files` 与安全 `DELETE /files/file-api-*`，供 010 adapter 的 fetch 使用。

## 验收标准

1. `pnpm exec vitest run apps/web/src/modelTransport/providerRoute.test.ts packages/host-node/src/model/providerRoute.test.ts scripts/model-preview-relay-routes.test.ts` → 允许与拒绝矩阵通过。
2. `pnpm exec tsc -b packages/host-node/tsconfig.json tsconfig.app.json` → 类型检查通过或只剩明确记录的共享 worktree 前置错误。
3. `wc -l packages/host-node/src/model/providerRoute*.ts` → 普通文件均不超过 300 行。
4. `git diff --check -- apps/web/src/modelTransport packages/host-node/src/model scripts/model-preview-relay-routes*` → 无空白错误。

## 执行记录（仅编排者回写）

- 2026-08-21：已派发首轮实现。
- 2026-08-21：执行报告聚焦 49/49、就近回归 29/29 通过；独立审查 APPROVED。编排者复跑
  三态路由 49/49 通过，任务完成。原验收中的 web tsconfig 路径已修正为根 `tsconfig.app.json`。
