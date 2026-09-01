# Agent Rollout 本地历史底座

创建：2026-09-01

基线：`d88409306988d6427877c76cbba9658dd5fa727e`

状态：完成

## 目标边界

把 root agent 与任意层级 child agent 的历史统一为同一种 rollout v1 记录：JSONL 是 append-only
原始证据，SQLite 是可删除、可重建的查询投影。保留现有 SQLite recovery snapshot 与 undo history，
它们继续负责运行恢复，不与 rollout 争夺同一个职责。

本树只建设历史底座：合同、落盘、投影、root/child 写入、Web/CLI 装配、重建和故障验收。
`list/read/search` 工具、FTS 排名、权限模型、UI 浏览器都不在本树；它们等待本树完成后另行重基线。

## 已裁决架构

```text
root recovery capture ─┐
                       ├─ AgentRolloutDriver.append
child model context ───┘          │
                                  ▼
                    global app-data rollout JSONL
                         │                  │
                         │ source of truth  │ reconcile
                         ▼                  ▼
                 SQLite query projection  rebuild command

现有 SQLite recovery snapshot / undo history：保持原职责与格式
```

- rollout 根目录位于操作系统 application-data 目录，与 `web-agent.db` 同级，而不是工作区。
- host 只接受逻辑 `AgentHistoryTarget`，不接受调用方拼出的文件路径。
- root 与 child 共用同一 record codec；host 分配 `historyId`、单调 `rolloutOrdinal` 和 `recordedAt`。
- JSONL append 是强持久化边界：加跨进程锁、整批追加、换行并 `fsync`；失败向执行路径抛出。
- SQLite 投影允许暂时落后；JSONL 成功而投影失败时返回 warning，后续 reconcile 从 byte offset 重放。
- session 删除不删除 rollout。本树不提供 delete、prune 或 compact API。
- server Web 使用 host command driver；CLI 直接使用 node driver；纯静态浏览器没有本地文件 driver。
- 旧 SQLite root 会话在首次 recovery capture 时幂等回填。旧 `.webAgent-archive` child trace 不迁移，
  后续查询层把它作为 `complete:false` 的兼容来源。

## 公共合同

```ts
export type AgentHistoryTarget =
  | { readonly kind: 'root'; readonly conversationId: string }
  | {
      readonly kind: 'child'
      readonly conversationId: string
      readonly runId: string
      readonly agentPath: string
    }

export interface AgentRolloutDriver {
  append(
    target: AgentHistoryTarget,
    mutations: readonly AgentRolloutMutationV1[],
  ): Promise<AgentRolloutAppendResult>
  reconcile(): Promise<AgentRolloutReconcileResult>
  flush(): Promise<void>
}
```

mutation 至少覆盖 `session_meta`、`turn_context`、`item_upsert`、`item_deleted` 与 `run_state`。
`item_upsert` 将缺失的 `ConversationItem.pending` 规范化为 `false`，将缺失的 `planStageId` 规范化为
`null`；两字段在 record 中始终存在，避免 JSON optional/undefined 产生多种等价编码。
persisted record 在 mutation 之上增加 `schemaVersion: 1`、`historyId`、`rolloutOrdinal`、
`recordedAt`。codec 必须拒绝未知版本、无界对象和非法 ordinal，且 round-trip 保留原始 `ModelItem`。

## 全局约束

- 编排者只写本目录、审查和调度；产品与测试代码由执行 agent 修改。
- 普通文件单一职责且不超过 300 行；强内聚复杂核心不超过 500 行，并在报告说明不可再拆理由。
- `agent-core/src/index.ts` 已 299 行，不得继续追加；新合同走 `@einfach-agent/core/history` 子路径。
- `commandArgs.ts` 已 289 行，rollout 参数在自己的 command handler 内收窄，不能继续堆入该文件。
- `childAgentLoop.ts`、`childAgentToolCalls.ts` 临近 300 行；写入职责必须抽到 recorder，触线就按职责拆。
- 执行者不得派子 agent、不得 commit，不得 reset、checkout 或覆盖用户无关改动。
- 每个叶子只改 frontmatter `files` 中列出的 owners；发现必须跨 owner 时先在报告中请求编排者重排。
- 执行报告只写 `reports/NNN-report.md`；独立审查只写 `reports/NNN-review.md`。
- 不移除或缩减现有 recovery snapshot 中的 `ConversationItem[]`，不改变 undo generation 语义。

## 任务树

- 1000 合同与路径 (`group`)
  - [010](010-rollout-contract-codec.md) 定义 rollout v1 合同与 codec (`leaf`，依赖：无)
  - [020](020-app-data-root.md) 提取共享 application-data 根目录 (`leaf`，依赖：无)
- 2000 物理存储与投影 (`group`)
  - [030](030-locked-jsonl-store.md) 实现带锁的 JSONL 主记录 (`leaf`，依赖：010、020)
  - [040](040-sqlite-projector.md) 实现可重放 SQLite 投影 (`leaf`，依赖：010、030)
  - [050](050-host-rollout-service.md) 组装 host service 与 command (`leaf`，依赖：030、040)
- 3000 历史生产者 (`group`)
  - [060](060-root-rollout-delta.md) 计算 root recovery 增量 (`leaf`，依赖：010)
  - [065](065-root-durability-binding.md) 绑定 root 强持久化边界 (`leaf`，依赖：060)
  - [070](070-child-rollout-recording.md) 完整记录 child 模型上下文 (`leaf`，依赖：010、065)
- 4000 装配与恢复 (`group`)
  - [080](080-web-cli-assembly.md) 装配 server Web 与 CLI (`leaf`，依赖：050、065、070)
  - [090](090-rebuild-and-docs.md) 提供离线重建与运维文档 (`leaf`，依赖：050)
- 5000 集成验收 (`group`)
  - [100](100-rollout-integration-audit.md) 审计并发、崩溃与回填 (`leaf`，依赖：080、090)
  - [110](110-final-regression-contracts.md) 同步最终回归契约 (`leaf`，依赖：100，最终全仓测试发现)

## 状态表

| id | 任务 | model | status | created | done |
| --- | --- | --- | --- | --- | --- |
| 010 | 定义 rollout v1 合同与 codec | gpt-5.6-sol | done | 2026-09-01 | 2026-09-01 |
| 020 | 提取共享 application-data 根目录 | gpt-5.6-terra | done | 2026-09-01 | 2026-09-01 |
| 030 | 实现带锁的 JSONL 主记录 | gpt-5.6-sol | done | 2026-09-01 | 2026-09-01 |
| 040 | 实现可重放 SQLite 投影 | gpt-5.6-sol | done | 2026-09-01 | 2026-09-01 |
| 050 | 组装 host service 与 command | gpt-5.6-sol | done | 2026-09-01 | 2026-09-01 |
| 060 | 计算 root recovery 增量 | gpt-5.6-terra | done | 2026-09-01 | 2026-09-01 |
| 065 | 绑定 root 强持久化边界 | gpt-5.6-sol | done | 2026-09-01 | 2026-09-01 |
| 070 | 完整记录 child 模型上下文 | gpt-5.6-sol | done | 2026-09-01 | 2026-09-01 |
| 080 | 装配 server Web 与 CLI | gpt-5.6-terra | done | 2026-09-01 | 2026-09-01 |
| 090 | 提供离线重建与运维文档 | gpt-5.6-terra | done | 2026-09-01 | 2026-09-01 |
| 100 | 审计并发、崩溃与回填 | gpt-5.6-sol | done | 2026-09-01 | 2026-09-01 |
| 110 | 同步最终回归契约 | gpt-5.6-terra | done | 2026-09-01 | 2026-09-01 |

## 就绪集与并发顺序

确认后第一批并行 010 与 020。随后 030 → 040 → 050 构成 host 主链；060 → 065 → 070
构成生产者主链，两条链可交错推进。050 与 070 都完成后派 080；090 可在 050 后并行；100 最后独立审计。
最多三个执行 agent 同时运行，保留一个槽给 reviewer。派发前若 HEAD 变化，先复核 owners 并更新叶子 `base`。

## 覆盖矩阵

| id | 场景 | owner | 必须证明 |
| --- | --- | --- | --- |
| C01 | server root 新会话 | 065、080 | recovery capture 同批内容进入 rollout，重启后可投影 |
| C02 | root append/update/reorder/delete | 060、065 | delta 顺序稳定，无重复，删除产生 tombstone |
| C03 | child 完整上下文 | 070 | system/user/assistant/tool/synthesis 与模型输入顺序一致 |
| C04 | nested/sibling child | 070 | 逻辑 target 映射到不同 history/file，不串 ordinal |
| C05 | CLI direct host | 080 | 不经过 HTTP 仍落到同一 application-data 目录 |
| C06 | static Web | 080 | 无文件 driver 时现有 IndexedDB/recovery 行为不回归 |
| C07 | macOS/Windows/Linux/custom path | 020、030 | 目录确定、segment 安全且不依赖 cwd |
| C08 | server/CLI 并发写同一 history | 030、100 | 锁内批写，无半行、重号或覆盖 |
| C09 | JSONL 成功、projection 前崩溃 | 040、050、100 | reconcile 重放且不产生重复 item |
| C10 | 删除投影后重建 | 040、090、100 | JSONL 单独恢复 catalog/items/state |
| C11 | 旧 SQLite root 首次回填 | 065、100 | 首次完整写入，后续 capture 幂等 |
| C12 | 删除 session | 065、100 | recovery 可删，rollout 文件与投影仍保留 |
| C13 | 现有 recovery/undo | 065、100 | generation、flush、恢复测试保持通过 |
| C14 | 旧 child workspace archive | — | 本树明确不迁移；后续查询层兼容 `complete:false` |
| C15 | search/FTS/tools | — | 明确不在本树，旧工具树保持 blocked |

## 验收总门

1. 各叶定向 Vitest、`pnpm exec tsc -b`、`pnpm check:boundaries`、`pnpm check:state` 通过。
2. `find`/`wc -l` 证明新增或大改普通文件不超过 300 行，无 `part1`、`xxx2`、大杂烩 `utils`。
3. 同一 target 的多进程并发 append 产生连续 ordinal、完整换行 JSONL，进程退出前 `flush()` 已排空。
4. 删除全部 rollout 投影表后，rebuild 只靠 JSONL 恢复相同的 history、item 顺序和 projection offset。
5. root 与 child 的下一次模型请求不会越过失败的 rollout 强写入；纯静态模式未配置 driver 时正常运行。
6. 删除 session、undo 回退或 projection 故障都不删除/覆盖 rollout 原始记录。

## 决策与代价

- JSONL 是历史证据，SQLite 是运行恢复真相加查询投影。错了的代价是以后统一一致性语义时要迁移双源边界。
- rollout 放全局 app-data。好处是 CLI/server 与跨工作区发现统一；错了的代价是要迁移已有全局文件到 workspace-local。
- root 在 recovery capture 边界生成 delta，而不是让同步 atom writer 直接异步写文件。代价是崩溃前未 capture 的内存改动不构成历史证据。
- root delta 遇到 previous/current `sessionId` 不一致时 fail-fast，不把它隐式当新会话。理由是 append-only
  历史一旦被错误 tombstone 污染无法补偿；代价是 coordinator 切换会话前必须显式重置 previous state。
- root recovery bridge 将 rollout append failure 返回既有 `RecoveryWriteOutcome {status:'error'}`，而不是
  reject Promise；所有模型执行 fence 已检查该 outcome 并阻断，fire-and-forget 旧调用也不会产生 unhandled
  rejection。代价是新增强边界调用方必须检查 outcome，不能只依赖 catch。
- source append 强、projection 最终一致。代价是读侧必须先 reconcile 或显式暴露 projection lag。
- parseable lock 的 PID 仍存活时绝不只因 mtime/heartbeat 过期抢锁；宁可 wait timeout。malformed owner
  才按 stale age 回收，死亡 PID 可立即回收。理由是重复 ordinal 比暂时不可写更难恢复；代价是活着但
  永久卡死的进程需要退出或人工处理 lock。
- service 的 reconcile/dedupe 必须通过 store prepared-append 在同一 target 的跨进程 source lock 内执行，
  否则 server/CLI 会同时基于旧投影双写等价 backfill。代价是锁临界区包含该 target 的 SQLite reconcile。
- 不自动迁移旧 child trace 和纯浏览器 IndexedDB。代价是后续查询层必须长期保留带 warning 的兼容适配器。
- 不提供删除。代价是磁盘只增不减；删除/导出/保留政策必须作为单独、用户可见的后续设计。
