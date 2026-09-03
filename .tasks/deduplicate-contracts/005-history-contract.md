---
id: 005
title: history target 与查询枚举只有一个契约 owner
kind: leaf
parent: 000
depends_on: [003]
discovered_from: null
model: gpt-5.6-sol
status: done
created: 2026-09-03
done: 2026-09-03
base: d2104e3
files:
  - packages/agent-core/src/history/
  - packages/host-node/src/history/
  - packages/host-node/src/rollout/
  - tools/agents/src/list-agent-histories/
  - tools/agents/src/list-agent-history-items/
  - tools/agents/src/read-agent-history-item/
  - tools/agents/src/search-agent-histories/
---

# history target 与查询枚举只有一个契约 owner

## 目标
让 history status、item role、target 形状、target identity 和查询限额从 agent-core 的单一运行时契约派生，host 与工具不再手写副本。

## 交付边界
核心 readonly values/decoder/identity、host cursor 与 SQL 消费、四个工具 schema 以及契约测试必须一同交付。SQL 可以保留方言拼接，但 target predicate 的字段规则不得自有一份。

## 上下文
- `packages/agent-core/src/history/historyQuery.ts` 已持有限额和 union types。
- target normalizer 分散在 historyCommands/historyInput/queryCursor/searchCursor/rolloutRecordCodec。
- `sameTarget`/`targetKey` 至少四份，SQL predicate 两份。
- 某些 envelope 有不同字符串总长度上限；共享 target 形状，不错误统一外围载荷限额。

## 覆盖矩阵行
- 非横切任务。

## 接口
### 消费
- `AgentHistoryTarget`、`AgentHistoryStatus`、`AgentHistoryItemRole`。
### 产出
- readonly 枚举值、`decodeAgentHistoryTarget`、`agentHistoryTargetKey/sameAgentHistoryTarget` 或等价窄接口。

## 验收标准
1. agent-core history、host history/rollout 与四个 agent history 工具的相关测试全部通过。
2. 静态测试或 `rg` 证明 status/role enum literals 与 target equality 不再在消费层重复维护。
3. cursor、legacy、SQLite query 对 root 和 child targets 的行为保持一致。
4. `pnpm exec tsc -b packages/agent-core/tsconfig.json packages/host-node/tsconfig.json tools/agents/tsconfig.json` → 通过。

## 执行记录（仅编排者回写）
- 2026-09-03：依赖 003 完成，派发执行 agent，base `d2104e3`。
- 2026-09-03：首审 REJECTED；R1 修复 legacy cursor 对升级前 target 属性顺序的兼容，并补手工旧 payload 测试。
- 2026-09-03：R1 独立复审 APPROVED；编排者复跑 215 tests 通过，准予提交。
