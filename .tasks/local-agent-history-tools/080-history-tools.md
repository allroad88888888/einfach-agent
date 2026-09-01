---
id: "080"
title: 注册四个历史工具
kind: leaf
parent: "4000"
depends_on: ["020", "070"]
discovered_from: null
model: gpt-5.6-terra
status: cancelled
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - tools/agents/src/list-agent-histories/list-agent-histories.ts
  - tools/agents/src/list-agent-histories/list-agent-histories.md
  - tools/agents/src/list-agent-histories/list-agent-histories.test.ts
  - tools/agents/src/list-agent-history-items/list-agent-history-items.ts
  - tools/agents/src/list-agent-history-items/list-agent-history-items.md
  - tools/agents/src/list-agent-history-items/list-agent-history-items.test.ts
  - tools/agents/src/read-agent-history-item/read-agent-history-item.ts
  - tools/agents/src/read-agent-history-item/read-agent-history-item.md
  - tools/agents/src/read-agent-history-item/read-agent-history-item.test.ts
  - tools/agents/src/search-agent-histories/search-agent-histories.ts
  - tools/agents/src/search-agent-histories/search-agent-histories.md
  - tools/agents/src/search-agent-histories/search-agent-histories.test.ts
  - tools/agents/src/index.ts
  - tools/standard/src/index.test.ts
---

# 注册四个历史工具

已合并进 070，避免把同一条用户可用链路拆得过细；本叶不再单独执行。

## 目标

按 agents 工具家族的一目录一实现/guide/test 形状交付四个只读模型工具。

## 工具

- `list_agent_histories({cursor?,limit?})`
- `list_agent_history_items({target,cursor?,limit?,roles?})`
- `read_agent_history_item({target,itemId,offset?,maxChars?})`
- `search_agent_histories({query,target?,cursor?,limit?,roles?})`

每个工具只负责严格 JSON schema、进度文案、调用 `ctx.agentHistory`、保留结构化 result/warnings/cursor 与统一异常映射。
未知 key 拒绝；capability 缺席返回稳定 `agent_history_unavailable`。limit/query/offset 在 capability 再次校验，tool
不能自行放宽。

guide 明确：范围是本机 app-data 全部 canonical history；所有 agent 无需授权；legacy 可能 partial；工具不删除、
恢复或重放历史。不得写“当前 workspace only”。

四工具登记进 agents registrar 与 standard registry；从 32 精确更新到 36，保持唯一性与重复 registrar 幂等。
四项不得加入 replayUnsafe/dangerous/workspace/verification 分类。

## 验收

1. 每项覆盖 name/schema、透传、无 capability、边界错误、provider exception、warning/cursor/nextOffset 不丢失。
2. target discriminated union 不接受路径、未知字段或不完整 child identity。
3. `pnpm exec vitest run tools/agents/src/list-agent-histories/list-agent-histories.test.ts tools/agents/src/list-agent-history-items/list-agent-history-items.test.ts tools/agents/src/read-agent-history-item/read-agent-history-item.test.ts tools/agents/src/search-agent-histories/search-agent-histories.test.ts tools/standard/src/index.test.ts` 通过。
4. `pnpm --filter @einfach-agent/tools-agents build` 与 standard tools build 通过；registry 精确 36 且无重复。
5. `rg -n "replayUnsafe" tools/agents/src packages/agent-core/src/runtime/toolReversibility.ts` 证明四名不在 unsafe 集合。
6. 所有新 source/test/guide 单一职责且 `<=300`。

## 禁止项

- 不在工具层 import store、atoms、Node fs、SQLite 或 host adapter。
- 不把四项揉进一个 `historyTools.ts`。
