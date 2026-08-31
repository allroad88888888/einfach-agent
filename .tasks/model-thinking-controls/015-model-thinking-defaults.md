---
id: "015"
title: 声明内置模型默认 Thinking 状态
kind: leaf
parent: "100"
depends_on:
  - "010"
discovered_from: "050"
model: gpt-5.6-terra
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - packages/agent-ai/src/builtinModelDescriptors.ts
  - packages/agent-ai/src/builtinThinkingCapabilities.test.ts
---

# 声明内置模型默认 Thinking 状态

## 目标

为支持 Thinking 的内置模型声明官方默认开关状态。

## 上下文

050 独立审查发现：`ModelThinkingCapability` 已预留 `defaultEnabled`，但 010 的内置 capability 未填该值，
导致 UI 只能把 `settings.thinking === undefined` 猜成 Off；而请求层实际会省略字段并使用 provider 默认。

按 index 已固定的官方来源，为所有 `toggle|effort` 内置 capability 显式写
`defaultEnabled: true`：DeepSeek V4 默认开启 Thinking；GLM-4.5+ 支持模型默认 enabled/动态 Thinking；
Kimi 配置文档的 Thinking 全局默认 enabled。`unsupported|unknown` 不声明默认，不得因此变成支持。

只补数据和逐模型测试，不改 UI、adapter 或 capability 类型。复用共享 capability 常量，不能为每个模型
复制一份对象。

## 接口

### 产出

- 受审内置 capability 的 `defaultEnabled`：050 R1 与 060 消费。

## 验收标准

1. `pnpm exec vitest run packages/agent-ai/src/builtinThinkingCapabilities.test.ts packages/agent-ai/src/modelThinkingCapability.test.ts` → 所有 supported 内置模型 defaultEnabled=true，unsupported/unknown 无默认且仍不支持。
2. `pnpm --filter @einfach-agent/ai build && git diff --check` → 通过。
3. 两个文件均不超过 300 行；测试文件若接近上限，使用 `it.each` 扩展现有矩阵，不复制逐模型 case。

## 执行记录（仅编排者回写）

- 2026-08-21：执行者验收全部通过；独立审查 APPROVE，无 findings。
