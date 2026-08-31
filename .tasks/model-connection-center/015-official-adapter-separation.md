---
id: "015"
title: 固化厂商 adapter 身份
kind: leaf
parent: "150"
depends_on: []
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - packages/agent-ai/src/builtinProviders.test.ts
  - apps/web/src/modelTransport/providerRoute.test.ts
  - apps/web/src/modelTransport/openAiCompatEndpoint.test.ts
---

# 固化厂商 adapter 身份

## 目标

证明兼容连接不能替代官方 adapter。

## 上下文

`packages/agent-ai/src/builtinProviders.ts` 现有四个不可变 vendor identity：官方
`deepseek`、`glm`、`kimi` 各有专属 request projection、descriptor 和 adapter；
`openai-compat` 只携带可选 `connectionId` 并使用标准 `/chat/completions` 请求。当前
`apps/web/src/modelTransport/providerRoute.ts` 按 adapter 发出的 origin 和内存身份把请求收窄为
`ProviderTarget`，而不是按模型名称猜厂商。

这个任务只加入/加强 characterization tests，不改变生产 adapter、endpoint 或 profile 代码。测试必须
明确把第三方 profile 的 label/model 写成看似官方的值（例如 `DeepSeek-R1`、`glm-5.2`、`kimi-k2.6`），
并证明名字不会决定 provider identity。

必须断言：

1. 官方 DeepSeek、GLM、Kimi 继续分别调用自己的 adapter，官方 DeepSeek 才会投影 `user_id` 和其
   `reasoning_effort` 取值域，GLM/Kimi 保持各自现有字段；
2. profile `connectionId` 的请求一律得到
   `{ provider: 'openai-compat', scope: 'default', method: 'POST', path: '/chat/completions', connectionId }`，
   不因模型 ID/label 变为官方 target；
3. profile 的 base URL 即使文本上包含官方名称，也只可由已登记 profile 解析；官方 origin 命中仍由
   没有 profile identity 的官方 adapter 识别；
4. 未登记 ID、URL 不全等和把 legacy/profile identity 混在一起仍在 browser transport 前拒绝。

不允许把 profile label/model 加进 transport target、wire request、endpoint registry 或 provider
settings；这会将 UI 文字错误升级为路由权力。

## 接口

### 消费

- `DEEPSEEK_VENDOR_ID`、`GLM_VENDOR_ID`、`KIMI_VENDOR_ID`、`OPENAI_COMPAT_VENDOR_ID` 及现有 adapter
  测试 hooks，来自 `packages/agent-ai/src/builtinProviders.ts`。
- `providerTargetForRequest()` 与 `ProviderTarget`，来自 web transport；010–060 均必须保持此身份契约。

### 产出

- 厂商 identity characterization suite：070 将其结果作为官方优化未回归的证据。

## 验收标准

1. `pnpm exec vitest run packages/agent-ai/src/builtinProviders.test.ts apps/web/src/modelTransport/providerRoute.test.ts apps/web/src/modelTransport/openAiCompatEndpoint.test.ts` → 官方三家适配器和同名第三方 profile 的身份分离断言全部通过。
2. `pnpm --filter @einfach-agent/ai build && git diff --check` → 全部通过。全仓 `tsc -b` 为 060/070
   消费端迁移后的总门，见 index 的裁决记录。

## 执行记录（仅编排者回写）

- 2026-08-21：R1 只补独立审查要求的 DeepSeek `reasoning_effort` 允许集合 characterization，更新
  报告并复跑本任务聚焦命令。
- 2026-08-21：R1 独立复审通过；官方 adapter 与同名第三方 profile 的身份分离得到验证。
