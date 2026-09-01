---
id: "010"
title: 定义 rollout v1 合同与 codec
kind: leaf
parent: "1000"
depends_on: []
discovered_from: null
model: gpt-5.6-sol
status: done
repair_round: 1
created: 2026-09-01
done: 2026-09-01
base: d88409306988d6427877c76cbba9658dd5fa727e
files:
  - packages/agent-core/src/history/agentHistoryTarget.ts
  - packages/agent-core/src/history/agentHistoryTarget.test.ts
  - packages/agent-core/src/history/rolloutMutation.ts
  - packages/agent-core/src/history/rolloutRecordCodec.ts
  - packages/agent-core/src/history/rolloutRecordCodec.test.ts
  - packages/agent-core/src/history/index.ts
  - packages/agent-core/package.json
  - packages/agent-core/tsup.config.ts
  - scripts/check-boundaries.js
---

# 定义 rollout v1 合同与 codec

## 目标

建立 root/child 共用的逻辑 target、mutation、persisted record、driver 与 v1 JSONL codec，作为其他叶子的唯一合同来源。

## 上下文

`packages/agent-core/src/index.ts` 已 299 行，不能继续追加。新增公共入口必须是
`@einfach-agent/core/history`，并同步 package exports、tsup entry 与 boundary allowlist。

## 接口

- `AgentHistoryTarget` 只允许 root `{conversationId}` 或 child `{conversationId, runId, agentPath}`。
- `AgentRolloutMutationV1` 是 `session_meta | turn_context | item_upsert | item_deleted | run_state` 判别联合。
- `AgentRolloutRecordV1` 增加 `schemaVersion: 1`、`historyId`、`rolloutOrdinal`、`recordedAt`。
- `AgentRolloutDriver` 精确提供 `append(target, mutations)`、`reconcile()`、`flush()`；不提供路径或删除接口。
- codec 一行一 record，只负责严格 decode/encode；大小上限导出为常量，物理 I/O 由 030 负责。

`item_upsert` 必须含稳定 `itemId`、`itemOrdinal`、`createdAt`、原始 `ModelItem`、必填
`pending: boolean` 与必填 `planStageId: string | null`；producer 将 absent 分别规范化为 `false`/`null`。
`item_deleted`
必须含 `itemId` 与 reason。不得用 `unknown` record 穿透类型检查。

## 验收标准

1. codec round-trip 覆盖五种 mutation，保留 `ModelItem` 结构与 Unicode。
2. 未知 schema、负 ordinal、非法 timestamp、缺 target 字段、超大单行均得到可诊断错误。
3. `pnpm exec vitest run packages/agent-core/src/history` → 通过。
4. `pnpm --filter @einfach-agent/core build` 与 `pnpm check:boundaries` → 通过。
5. `wc -l` 证明所有新文件不超过 300 行；root `src/index.ts` 行数不增加。

## 禁止项

- 不实现文件路径、SQLite、搜索或兼容旧 trace。
- 不把所有类型塞入一个 `types.ts`；target、mutation、codec 各守单一职责。
