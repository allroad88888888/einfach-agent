---
id: "060"
title: 审核最新模型全链路
kind: leaf
parent: "300"
depends_on: ["055"]
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-31
done: 2026-08-31
base: 5ad0f617571f96de36305019c531a258c0fb4e25
files:
  - packages/agent-ai/src/latestBuiltinModels.integration.test.ts
  - apps/web/src/agentNew/ui/LatestModelControls.audit.test.tsx
---

# 审核最新模型全链路

## 目标

证明六个最新内置模型从选择器到线协议完整闭合。

## 粒度

这是只补缺口的跨层 coverage audit，预计 15–20 分钟；它独立于各实现叶并可否决整树交付。

## 上下文

逐行检查 index 的 C-01～C-13。优先引用既有专项测试，不制造重复断言；只有缺少跨层证据时才在本叶
两个专责 integration/audit 文件中补最小测试。不得在审计叶修产品代码，发现 Important 以上问题退回
原任务修复后重审。

视觉验收使用本地 Web 服务与注入/假凭据，不调用真实模型。确认 Auto、required On、optional Off、
模型切换、窄窗口、键盘与 aria 状态。

## 覆盖矩阵行

- `C-01`～`C-13`：最终证据 owner。

## 接口

### 消费

- 010～055 的最终产品代码、测试报告与静态扫描 allowlist。

### 产出

- 无产品接口；报告给出每行覆盖证据和最终门结果。

## 验收标准

1. C-01～C-13 每行都有测试、源码或必要视觉证据，无“推测通过”。
2. `pnpm exec tsc -b --pretty false && pnpm check:state && pnpm check:boundaries` 全过。
3. 目标 Vitest、`pnpm lingui:extract --clean`、`pnpm lingui:compile`、`pnpm build`、
   `git diff --check` 全过。
4. `wc -l` 证明新增/大改普通文件 ≤300；独立 Sol reviewer 基于全量范围 diff APPROVED。
