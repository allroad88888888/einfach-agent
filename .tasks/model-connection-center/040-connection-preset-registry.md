---
id: "040"
title: 提供连接来源预设
kind: leaf
parent: "200"
depends_on:
  - "010"
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-08-21
done: 2026-08-21
base: c7befb48ea8c38a91d10c58097cb1206fbef8cc1
files:
  - apps/web/src/settings/modelConnectionPresetRegistry.ts
  - apps/web/src/settings/modelConnectionPresetRegistry.test.ts
---

# 提供连接来源预设

## 目标

为兼容连接给出可信来源预设。

## 上下文

现有 UI 把每个第三方目标都表述为裸 `Base URL`，用户无法区分官方 DeepSeek、第三方托管的
DeepSeek 和自部署服务。本任务只新增纯数据 registry，不请求网络、不读写 config、不渲染 UI。

新文件导出：

```ts
export type ModelConnectionPresetCategory = 'cloud' | 'self-hosted' | 'local'
export interface ModelConnectionPreset {
  readonly id: string
  readonly label: string
  readonly category: ModelConnectionPresetCategory
  readonly protocol: 'openai-compatible'
  readonly baseUrl: string
  readonly models: readonly ConnectionProfileModel[]
  readonly documentationUrl?: string
}
export function modelConnectionPreset(id: string): ModelConnectionPreset | undefined
export function modelConnectionPresets(): readonly ModelConnectionPreset[]
```

采用明确、可复现的首批预设：OpenRouter、硅基流动、火山方舟（cloud）；vLLM、SGLang（self-hosted，
地址留空）；Ollama OpenAI compatibility、LM Studio（local，使用既有回环 HTTP 规则）。不得把官方
DeepSeek、GLM、Kimi 放入此 registry，因为它们已有专属官方 adapter/Key 流程。所有预置 remote URL
必须通过 `normalizeOpenAiCompatBaseUrl` 的结构约束；model 列表只提供常见示例，不声称已探测或保证
服务商仍提供它们。

内容须可稳定排序且返回防御性副本，调用方不可修改 registry。ID 是本应用内稳定 kebab-case key，
不等于用户 connection ID。

## 接口

### 消费

- `ConnectionProfileModel`：来自 010；为预置 model 使用 `source: 'manual'`。

### 产出

- `modelConnectionPresets()`、`modelConnectionPreset(id)`：060 的来源选择页消费。

## 验收标准

1. `pnpm exec vitest run apps/web/src/settings/modelConnectionPresetRegistry.test.ts` → 每个预设 category、协议、合法地址/可空自部署地址、稳定排序与防御性副本通过。
2. `git diff --check` → 通过。全 app 类型总门由 060 在全部消费方迁移后执行，见 index 裁决。

## 执行记录（仅编排者回写）

- 2026-08-21：执行完成，专属测试通过，等待独立审查；全 app 类型门按 index 裁决延至 060/070。
- 2026-08-21：独立审查通过；未发现质量问题。
