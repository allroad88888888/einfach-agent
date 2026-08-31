---
id: "040"
title: 仅支持 Kimi K3
kind: leaf
parent: "200"
depends_on: ["030"]
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-31
done: 2026-08-31
base: 98816b041b42d55ee3308a909af8e8cf7f646f36
files:
  - packages/agent-ai/src/kimi.ts
  - packages/agent-ai/src/kimiRegion.ts
  - packages/agent-ai/src/builtinModelDescriptors.ts
  - packages/agent-ai/src/builtinProviders.ts
  - packages/agent-ai/src/builtinThinkingCapabilities.test.ts
  - packages/agent-ai/src/thinkingRequestProjection.test.ts
  - packages/agent-ai/src/kimiK3Protocol.test.ts
  - packages/subagents/src/defaultTierRoutingTable.ts
  - packages/subagents/src/defaultTierRouting.test.ts
  - apps/web/src/agentNew/ui/ModelCredentialPanel.tsx
  - apps/web/src/settings/startupCredentialTarget.test.ts
---

# 仅支持 Kimi K3

## 目标

把内置 Kimi 模型替换为 Kimi K3。

## 粒度

K3 的目录、请求体、默认模型、凭据表面与 tier routing 构成一个切换闭环，预计 20 分钟。

## 上下文

K2.6 使用 `thinking:{enabled|disabled}` 且不支持 effort；K3 相反：始终思考，不接受 K2.x `thinking`，
只接受顶层 `reasoning_effort: low|high|max`，默认 max，上下文为 1M。Kimi 的 CN/global endpoint 与
region 设置保留。

## 覆盖矩阵行

- `C-01`、`C-06`、`C-07`、`C-10`：K3 目录、强制思考、wire 与 routing。

## 接口

### 消费

- 010 的 required 语义；现有 Kimi region 与消息编码。

### 产出

- `KIMI_K3_MODEL = 'kimi-k3'` 且 `DEFAULT_KIMI_MODEL` 指向它。
- K3 request 只投影合法 `reasoning_effort`，删除任何 `thinking` 字段。

## 验收标准

1. Kimi registry 只有 K3，模型与 vendor fallback context 均为 1M，capability 为 required +
   low/high/max + default max。
2. K3 Auto 不发 effort，三档原样发送；任何路径都不发 `thinking`。
3. CN/global base URL、region setting、credential target 与普通文本流式/非流式调用不回归。
4. Kimi 与 subagents 专项测试、类型检查、diff check 通过。
