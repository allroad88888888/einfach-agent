---
id: 008
title: delegate_agent schema、解析与文档由同一能力集合驱动
kind: leaf
parent: 000
depends_on: [001]
discovered_from: null
model: gpt-5.6-terra
status: done
created: 2026-09-03
done: 2026-09-03
base: 4b911d1
files:
  - packages/agent-core/src/subagents/input.ts
  - packages/agent-core/src/subagents/input.test.ts
  - packages/agent-core/src/subagents/continuationDescriptor.test.ts
  - packages/agent-core/src/subagents/toolProfile.ts
  - packages/agent-core/src/subagents/toolProfile.test.ts
  - packages/agent-core/src/subagents/types.ts
  - packages/agent-core/src/subagents/index.ts
  - packages/agent-core/src/runtime/dangerousTools.ts
  - packages/agent-core/src/runtime/dangerousTools.test.ts
  - packages/agent-core/src/runtime/toolContext.workspaceRoot.test.ts
  - tools/agents/src/delegate-agent/
---

# delegate_agent schema、解析与文档由同一能力集合驱动

## 目标
让 delegate_agent 的模型档位、任务类别、风险等级、tool profile 和可委派危险工具从 agent-core 的 readonly 能力集合派生，schema、parser 与 guide 不再人工同步。

## 交付边界
核心枚举值、normalizer、工具 schema、guide 和防漂移测试必须一起交付。MCP 仍不可委派，危险能力的 host-issued scope 不得放宽。

## 上下文
- schema 在 `tools/agents/src/delegate-agent/delegate-agent.ts`。
- parser 在 `packages/agent-core/src/subagents/input.ts`。
- dangerous set 在 `packages/agent-core/src/runtime/dangerousTools.ts`。
- guide 当前漏写 delete/copy/move/revert；Markdown 无法直接从 TS 运行时生成时，应以测试从 canonical 集合锁定展示内容，而不是新增第四份无约束列表。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- `DANGEROUS_TOOLS` 中可委派的内建工具策略。
### 产出
- readonly capability values 和对应 union types，供 normalizer 与 JSON schema 消费。

## 验收标准
1. agent-core subagent input 与 delegate-agent 工具测试全部通过。
2. 契约测试证明 JSON schema 枚举、normalizer 接受集合、guide 展示集合与 canonical values 一致。
3. `pnpm exec tsc -b packages/agent-core/tsconfig.json tools/agents/tsconfig.json` → 通过。

## 执行记录（仅编排者回写）
- 2026-09-03：依赖 001 完成，派发执行 agent，base `4b911d1`。
- 2026-09-03：首审 REJECTED；R1 纳入 tool profile owner/test，修复派生类型、root dangerous 全集与可委派子集关系、guide 完整性。
- 2026-09-03：R1 复审仍 REJECTED；R2 仅修正反向维护注释/测试名、悬空 profile JSDoc，并补齐任务 files 记录。
- 2026-09-03：R2 独立复审 APPROVED；编排者复跑 96 tests 通过，准予提交。
