---
id: "010"
title: 建立逐模型 Thinking 能力表
kind: leaf
parent: "100"
depends_on: []
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - packages/agent-ai/src/modelThinkingCapability.ts
  - packages/agent-ai/src/builtinModelDescriptors.ts
  - packages/agent-ai/src/providerRegistry.ts
  - packages/agent-ai/src/builtinProviders.ts
  - packages/agent-ai/src/modelThinkingCapability.test.ts
  - packages/agent-ai/src/builtinThinkingCapabilities.test.ts
  - packages/agent-ai/src/index.ts
---

# 建立逐模型 Thinking 能力表

## 目标

为每个内置模型声明可验证的 Thinking 能力。

## 上下文

`providerRegistry.ts` 的 `ModelDescriptor` 当前只有上下文与图片能力；`builtinProviders.ts` 同时承担
adapter 装配和约 20 个模型描述，已 239 行。现有 `ComposerThinkingControl.tsx` 把 Auto/Low/Medium/High
写死，既不符合 DeepSeek V4 的 `high|max`，也无法表达 GLM 旧模型与 Kimi 的 toggle-only。

新增 `modelThinkingCapability.ts`，只定义并查询 Thinking capability；最少能区分
`unsupported|toggle|effort|unknown`，effort 列表使用只读、稳定顺序并允许声明默认开启、默认 effort、
兼容映射说明和官方 source URL。`Auto` 不进入 wire effort union。

新增 `builtinModelDescriptors.ts`，只保存内置模型的 display label、context/image 与 Thinking 配置；把
逐模型数据从 `builtinProviders.ts` 抽出，后者继续只负责 adapter 装配。`ProviderRegistry` 提供只读枚举
已注册模型的通用查询，UI 不再重复列 vendor/model。未知 adapter/model 必须返回 `unknown`，不能继承
fallback DeepSeek capability。

能力值严格按 index 的官方表。GLM-5.2 的 UI effort 顺序为 low、medium、high、xhigh、max；
`minimal|none` 记录为关闭别名或协议元数据，不进入正向档位。DeepSeek 只列 high、max。Kimi K2.6
toggle-only。GLM-4.5 以下模型 unsupported。

## 接口

### 产出

- `ModelThinkingCapability` 与查询/判定函数：020、040、045 消费。
- `ModelDescriptor.displayName` 与 registry 模型枚举：040 消费。
- 内置 model descriptor 表：adapter registry 与 UI 共享，不能包含凭据或 endpoint。

## 验收标准

1. `pnpm exec vitest run packages/agent-ai/src/modelThinkingCapability.test.ts packages/agent-ai/src/builtinThinkingCapabilities.test.ts packages/agent-ai/src/providerRegistry.test.ts` → index 表中所有模型逐项通过，未知模型为 unknown，枚举稳定且不可变。
2. 测试明确断言 DeepSeek 不出现 low/medium/xhigh、GLM-5.2 不把 minimal/none 当正向档位、Kimi 无伪造 effort。
3. `pnpm --filter @einfach-agent/ai build && git diff --check` → 通过。
4. `wc -l` 检查本任务新增/大改普通文件均不超过 300 行；`builtinProviders.ts` 不再同时承载模型数据。

## 执行记录（仅编排者回写）

- 2026-08-21：执行者验收全部通过；独立审查 APPROVE，无 findings。
