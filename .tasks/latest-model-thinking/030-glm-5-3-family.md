---
id: "030"
title: 仅支持 GLM-5.3 系列
kind: leaf
parent: "200"
depends_on: ["020"]
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-08-31
done: 2026-08-31
base: e146e46e147c2cdc9790b4f51a62355a1c4184df
files:
  - packages/agent-ai/src/glm.ts
  - packages/agent-ai/src/builtinModelDescriptors.ts
  - packages/agent-ai/src/builtinProviders.ts
  - packages/agent-ai/src/builtinThinkingCapabilities.test.ts
  - packages/agent-ai/src/thinkingRequestProjection.test.ts
  - packages/agent-ai/src/glm53Protocol.test.ts
  - packages/subagents/src/defaultTierRoutingTable.ts
  - packages/subagents/src/defaultTierRouting.test.ts
---

# 仅支持 GLM-5.3 系列

## 目标

把内置 GLM 产品面替换为 GLM-5.3 与 GLM-5.3-Flash。

## 粒度

模型目录、官方请求约束与 tier routing 必须同批闭合，预计 20 分钟；拆开会让中间状态路由到已移除 ID。

## 上下文

当前默认是 glm-5.2，catalog 还列出十余个旧模型。目标两模型均为 1M context、low/high/max、默认 max，
且只允许 Thinking enabled。GLM-5.3 是 Pro tier，GLM-5.3-Flash 是 Flash tier。Flash 的多模态输入本树不
开放，descriptor 必须诚实保持未审计/不支持，而不是按宣传页直接宣称可上传。

## 覆盖矩阵行

- `C-01`、`C-04`、`C-05`、`C-10`：GLM 目录、强制思考、wire 与子 Agent 路由。

## 接口

### 消费

- 010 的 `modelRequiresThinking()`；020 后的共享 catalog/projection 结构。

### 产出

- `GLM_PRO_MODEL = 'glm-5.3'`、`GLM_FLASH_MODEL = 'glm-5.3-flash'`，默认指向 Pro。
- `GlmReasoningEffort = 'low' | 'high' | 'max'`。

## 验收标准

1. GLM registry 精确只有 5.3 与 5.3-Flash，均 required、三档、1M context。
2. 任意会话脏 `thinking:false` 在请求边界都投影为 enabled；wire 只允许 low/high/max。
3. 子 Agent Pro/Flash 分别路由到两个新 ID，旧 ID 不再由生产 routing 产出。
4. GLM 与 subagents 专项测试、类型检查、边界检查、diff check 通过。

## 执行记录（仅编排者回写）

- 执行 DONE_WITH_CONCERNS：本叶 45 tests 及全部静态门通过；4 个旧 GLM 夹具失败归属 055。
- 独立 Sol reviewer APPROVED：四项验收与 C-01/C-04/C-05/C-10 闭合，仅报告旧编号为 Minor。
- 编排者复跑协议、capability、routing：3 files / 30 tests 通过。
