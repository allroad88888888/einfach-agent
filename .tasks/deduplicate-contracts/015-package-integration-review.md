---
id: 015
title: 包边界与运行时集成复审不发现阻断缺口
kind: leaf
parent: 000
depends_on: [001, 002, 003, 004, 005, 006, 007, 008, 009, 011, 012, 013]
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-09-03
done: 2026-09-03
base: 55a3d2e
files:
  - apps/server/**
  - apps/web/src/modelTransport/**
  - packages/*/package.json
  - packages/agent-ai/**
  - packages/host-node/src/model/**
  - pnpm-lock.yaml
  - tsup.preset.ts
---

# 包边界与运行时集成复审不发现阻断缺口

## 目标
独立复审包依赖、构建 externalization、运行时环境边界与 provider policy 接线，报告任何发布后才会出现的缺依赖、重复打包、循环依赖或浏览器/Node 污染。

## 交付边界
这是只读审查；不改产品代码、不提交。重点检查 manifest/lock/import 一致性、tsup 输出规则、Web/server/host/relay 的共享 policy 消费与 follow-up `2eee1e1`。

## 上下文
首轮终审曾发现 server 未声明 `@einfach-agent/ai`，后由 `2eee1e1` 修复并新增真实打包边界测试。本轮必须从当前代码独立验证该闭环以及其它跨包变化。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- `git diff 55a3d2e..2eee1e1`：完整交付差异。
### 产出
- `reports/015-report.md`：按 Critical / Important / Minor 分级的独立审查报告。

## 验收标准
1. 直接运行时依赖、lock importer、公开 exports 与构建 externalization 逐层核对并给出证据。
2. Node-only 与浏览器共享层边界、provider policy 单一 owner、跳过的第 10 项均有明确结论。

## 执行记录（仅编排者回写）
- 2026-09-03：并行派发只读复审。
- 2026-09-03：APPROVED；无 Critical/Important/Minor；报告 `reports/015-report.md`。
