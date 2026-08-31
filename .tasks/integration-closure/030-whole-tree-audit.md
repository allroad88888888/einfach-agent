---
id: "030"
title: 审核五棵树集成交付
kind: leaf
parent: "200"
depends_on: ["010", "020", "tauri-server-web-modes/065"]
discovered_from: null
model: gpt-5.6-sol
status: blocked
superseded_by: "050"
created: 2026-08-31
done: null
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - .tasks/integration-closure/reports/030-report.md
---

# 审核五棵树集成交付

## 目标

证明五棵功能树在同一工作区组成可构建交付。

## 上下文

这是只读产品审计叶，唯一可写文件是本报告。它取代 Lingui 120/150 缺失的历史独立 review，并核对
DeepSeek Vision、模型连接、Thinking、Lingui、Tauri 及本树 010/020 的最终证据。不得修产品；发现漏项
必须按精确路径、严重级别和归属树报告。

## 验收标准

1. `pnpm test` → 全量通过，给出文件数与测试数。
2. `pnpm exec tsc -b --pretty false && pnpm check:state && pnpm check:boundaries` → 通过。
3. `pnpm lingui:extract --clean && pnpm lingui:compile` → English Missing 0，catalog 无意外漂移。
4. `pnpm build`、`node scripts/check-desktop-wrapper.mjs`、`pnpm desktop:build`、`git diff --check` → 通过。
5. 对全部新增/大改普通文件执行 `wc -l`；例外与存量超限逐项分类，不能把新违规标绿。
6. 逐树核对最终 report/review、遗留裁决与状态；Lingui 的中英文覆盖须用真实 Provider 证据。

## 执行记录（仅编排者回写）

- 2026-08-31：010、020 与 Tauri 065 均已完成，开始全树集成审计。
- 2026-08-31：机械门全绿，但首次 Lingui clean extract 改写 catalog；登记 035 稳定产物、040 处理本次放大的类型文件超限，并由 050 重跑最终门。
