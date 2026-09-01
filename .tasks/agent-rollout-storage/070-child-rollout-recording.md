---
id: "070"
title: 完整记录 child 模型上下文
kind: leaf
parent: "3000"
depends_on: ["010", "065"]
discovered_from: null
model: gpt-5.6-sol
status: done
repair_round: 2
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/agent-core/src/subagents/childRolloutRecorder.ts
  - packages/agent-core/src/subagents/childRolloutRecorder.test.ts
  - packages/agent-core/src/subagents/childAgentLoop.ts
  - packages/agent-core/src/subagents/childAgentToolCalls.ts
  - packages/agent-core/src/subagents/runtime.childRollout.test.ts
---

# 完整记录 child 模型上下文

## 目标

让任意层级 child 把实际进入模型上下文的条目强写为统一 rollout，不再把 best-effort UI trace 当历史。

## 上下文

现有 child history 只存在 `loop.messages` 内存；`.webAgent-archive/traces` 仅含 assistant/tool 且吞写错误。
保留 trace 原行为。新 `childRolloutRecorder.ts` 单独负责构造 target、分配稳定 item id/ordinal 与调用 driver。

## 写入时点

1. `child_started` 后、第一次模型调用前：同批写 initial system + user 与 run state。
2. 每次模型响应进入 `loop.messages` 后：先 await assistant item upsert，再判断 finish reason/执行工具。
3. 每个实际 push 到上下文的 tool result：push 后立即 await upsert，下一轮 model call 不能越过它。
4. max-turn 强制 synthesis user：调用合成模型前先 await upsert。
5. final：写 terminal run state、await driver flush，二者成功后才把 scheduler/archive finalize 为 done。
6. failed/cancelled：尝试写 terminal 并 flush，但收尾写失败不得覆盖原始错误或阻止结构化 failed/cancelled finalize。

target 使用当前 `conversationId/runId/agentPath`，嵌套 child 不能继承父 agentPath 当作自己的 history。
driver 未配置（纯静态模式）时 recorder 是明确 no-op，既有 trace 继续工作，但不得声明完整 rollout。

## 验收标准

1. 两轮 child 的 mutation 顺序为 system、user、assistant(tool call)、tool、synthesis user、assistant(final)。
2. assistant/tool/initial/synthesis 任一 append 失败，都阻止后续模型请求并让 child failed；错误不被 trace 捕获吞掉。
3. sibling/nested child 产生不同 target；各自 itemOrdinal 从 0 连续，父子不串历史。
4. driver 缺失时现有 child 与 archive observability tests 不回归。
5. `pnpm exec vitest run packages/agent-core/src/subagents/childRolloutRecorder.test.ts packages/agent-core/src/subagents/runtime.childRollout.test.ts packages/agent-core/src/subagents/childAgentLoop.timed.test.ts` → 通过。
6. `childAgentLoop.ts`、`childAgentToolCalls.ts` 仍不超过 300 行；触线必须按职责抽 helper 并先报告 owner 变更。

## 禁止项

- 不改写或删除现有 trace/run events，不把 UI event 伪装成 model item。
- 不在 child loop 里实现路径、JSONL codec 或 SQLite。
