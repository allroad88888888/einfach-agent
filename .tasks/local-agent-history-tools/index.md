# 本机任意 Agent 历史查询工具

创建：2026-09-01

重基线：2026-09-01

Git 基线：`d88409306988d6427877c76cbba9658dd5fa727e`

依赖工作树：`../agent-rollout-storage` 已完成且尚未单独提交；本树执行与审查必须保留该工作树。

状态：已完成

范围收缩（2026-09-01）：用户要求优先完成几个工具本身。global list/search 固定只走canonical
SQLite/FTS；legacy仅保留明确target的兼容fallback。取消055–058的跨filesystem全局有序分页，不再把
compatibility source做成第二套数据库查询引擎。

## 目标边界

向 root agent 与任意层级 child agent 提供四个只读工具：

- `list_agent_histories`
- `list_agent_history_items`
- `read_agent_history_item`
- `search_agent_histories`

canonical 范围是同一台机器 application-data 目录中的全部 rollout 历史，不按当前 workspace 过滤。
root、child、sibling、ancestor、descendant 只要拿到工具即可读取任意逻辑 target；不实现 ACL、调用者身份、
ancestor 判断、批准弹窗、scope token 或敏感字段遮罩。工具只接收逻辑 `AgentHistoryTarget`，不接收文件路径。

现有 rollout JSONL 是唯一原始证据，SQLite catalog/events/items/turns/projection_state 五表是可重建读模型。
本树不再创建 root/child transcript 文件。旧 root recovery snapshot 与当前 workspace 的旧 child trace 仅作为
只读 compatibility source，固定 `complete:false` 并返回 warning；绝不回填不存在的消息或反写 canonical source。

## 已裁决架构

```text
ToolContext.agentHistory
          │
          ├─ static Web：capability 缺席 → AGENT_HISTORY_UNAVAILABLE
          │
          ├─ server Web：HTTP host commands ─┐
          │                                  ├─ history query service
          └─ CLI：direct capability ─────────┘          │
                                                       ├─ canonical rollout 五表
                                                       ├─ FTS5 派生索引
                                                       └─ legacy fallback
```

- 正常 list/items/read 只查 rollout 五表；查询前先 reconcile，source corruption fail-closed。
- FTS5 表 `agent_history_search_fts` 与 `agent_history_search_state` 由 search owner 独立维护，不加入
  `AGENT_ROLLOUT_PROJECTION_TABLES`，不修改 rollout projector。FTS 可删、可从 events 重建。
- FTS 以每 history 的 indexed ordinal 消费 `agent_rollout_events`；单次 catch-up 有界。尚未追平返回
  `SEARCH_INDEX_LAG`，不可回退到全库同步扫描。
- public capability 输入不含 workspace path。ToolContext 装配层只把当前会话的 workspace root 作为隐藏 legacy
  locator 绑定到 provider；它不限制 canonical 全局结果，也不构成权限判断。
- canonical running history 可 `complete:false` 但不带 partial warning；terminal done/stopped/error 才 complete。
  legacy 固定 `status:'legacy'`、`complete:false`、`LEGACY_PARTIAL_HISTORY`。

## 公共查询合同

`@einfach-agent/core/history` 新增：

```ts
export interface AgentHistoryCapability {
  listHistories(input: ListAgentHistoriesInput): Promise<ListAgentHistoriesResult>
  listItems(input: ListAgentHistoryItemsInput): Promise<ListAgentHistoryItemsResult>
  readItem(input: ReadAgentHistoryItemInput): Promise<ReadAgentHistoryItemResult>
  search(input: SearchAgentHistoriesInput): Promise<SearchAgentHistoriesResult>
}

export interface AgentHistoryCapabilityProvider {
  forContext(input: { readonly legacyWorkspaceRoot?: string }): AgentHistoryCapability
}
```

- list 默认 20、最大 100；按 `updatedAt DESC, historyId ASC`。
- items 默认 20、最大 100；按 `itemOrdinal, itemId`；默认跳过 tombstone；preview 最多 2,000 字符。
- read 默认/最大 20,000 Unicode code points，返回 `nextOffset` 与 `totalChars`。
- search query trim 后 1–1,000 字符，默认 20、最大 50；snippet 最多 1,000 字符。
- page 总序列化输出上限 100,000 字符，截断时返回 cursor 与 `OUTPUT_TRUNCATED`。
- cursor 是严格校验的 versioned base64url JSON，不是安全令牌；绑定 query kind、规范化 filters、snapshot 与
  last sort key。canonical snapshot 使用 append-only events count 或 target last ordinal；变化时稳定返回
  `AGENT_HISTORY_CURSOR_STALE`。
- 单 item JSON decode 有独立字节上限；read 字符上限不能掩盖无界内存分配。

## 全局约束

- 编排者只写本目录、审查和调度；产品与测试代码由执行 agent 修改。
- 普通文件只负责一个业务点或抽象且 `wc -l <=300`；复杂核心不超过 500 且需报告强内聚理由。
- `tools/types.ts` 299 行，010 必须先拆；`childAgentLoop.ts` 294、`childAgentToolCalls.ts` 292、
  `rollout/projector.ts` 287，任何叶不得继续向这些文件追加历史职责。
- `commandArgs.ts` 289 行；history command 参数在自己的 handler 内收窄，不追加该文件。
- JSONL、rollout 五表、recovery snapshot、undo history 的既有职责与格式不得缩减。
- 四工具只读且 replay-safe；不得写入、删除、prune、compact、repair source 或修改 session。
- source corruption 不能降级成 legacy warning；projection lag 与 search lag 必须分类，不反转强持久化语义。
- 旧 `.webAgent-archive` trace 可被既有 retention 清理；它是 best-effort fallback，不承诺永久存在。
- 执行者不得派子 agent、不得 commit、不得 reset/checkout，不得覆盖用户无关改动。
- 每叶只改 frontmatter `files` owners；执行报告只写 `reports/NNN-report.md`，独立审查只写
  `reports/NNN-review.md`。

## 任务树

- 1000 合同 (`group`)
  - [010](010-tool-context-contract.md) 拆出 ToolContext 合同 (`leaf`，依赖：020)
  - [020](020-history-query-contract.md) 定义历史查询合同 (`leaf`，依赖：无)
- 2000 canonical 与兼容读侧 (`group`)
  - [030](030-rollout-read-repository.md) 查询 rollout 五表 (`leaf`，依赖：020)
  - [040](040-legacy-history-adapters.md) 读取 legacy root/child (`leaf`，依赖：020)
  - [050](050-history-search-index.md) 建立 FTS5 派生索引 (`leaf`，依赖：020、030)
  - [055](055-legacy-ordered-source-pages.md) 为 legacy source 提供有界全局有序页 (`group`，已取消)
    - [056](056-legacy-ordered-scan-contract.md) 定义 ordered scan 状态合同 (`leaf`，依赖：040)
    - [057](057-legacy-child-ordered-pages.md) 接入 child legacy ordered pages (`leaf`，依赖：056)
    - [058](058-legacy-root-ordered-pages.md) 接入 root recovery ordered pages (`leaf`，依赖：056)
- 3000 service 与宿主装配 (`group`)
  - [060](060-history-query-service.md) 组合 query service 与 host routes (`leaf`，依赖：030、040、050)
  - [070](070-history-capability-assembly.md) 端到端装配并注册四个历史工具 (`leaf`，依赖：010、060；合并080/090/100)
- 4000 工具与可见性 (`group`)
  - [080](080-history-tools.md) 注册四个历史工具 (`leaf`，已并入070)
  - [090](090-child-history-tool-visibility.md) 向所有 child profile 开放工具 (`leaf`，已并入070)
- 5000 文档与验收 (`group`)
  - [100](100-history-tools-docs.md) 固化 global/legacy/search 语义 (`leaf`，已并入070)
  - [110](110-history-integration-audit.md) 完成跨 agent 集成审计 (`leaf`，已并入070独立复审)

## 状态表

| id | 任务 | model | status | created | done |
| --- | --- | --- | --- | --- | --- |
| 010 | 拆出 ToolContext 合同 | gpt-5.6-terra | done | 2026-09-01 | 2026-09-01 |
| 020 | 定义历史查询合同 | gpt-5.6-sol | done (R3) | 2026-09-01 | 2026-09-01 |
| 030 | 查询 rollout 五表 | gpt-5.6-sol | done (R2) | 2026-09-01 | 2026-09-01 |
| 040 | 读取 legacy root/child | gpt-5.6-sol | done (R3) | 2026-09-01 | 2026-09-01 |
| 050 | 建立 FTS5 派生索引 | gpt-5.6-sol | done (R2) | 2026-09-01 | 2026-09-01 |
| 056 | 定义 legacy ordered scan 状态合同 | gpt-5.6-sol | cancelled after R2 PASS (scope cut) | 2026-09-01 | 2026-09-01 |
| 057 | 接入 child legacy ordered pages | gpt-5.6-sol | cancelled (scope cut) | 2026-09-01 | 2026-09-01 |
| 058 | 接入 root recovery ordered pages | gpt-5.6-sol | cancelled (scope cut) | 2026-09-01 | 2026-09-01 |
| 060 | 组合 query service 与 host routes | gpt-5.6-sol | done (simplified R3) | 2026-09-01 | 2026-09-01 |
| 070 | 端到端装配并注册四个历史工具 | gpt-5.6-sol | done (R2) | 2026-09-01 | 2026-09-01 |
| 080 | 注册四个历史工具 | gpt-5.6-terra | cancelled (merged into 070) | 2026-09-01 | 2026-09-01 |
| 090 | 向所有 child profile 开放工具 | gpt-5.6-terra | cancelled (merged into 070) | 2026-09-01 | 2026-09-01 |
| 100 | 固化 global/legacy/search 语义 | gpt-5.6-terra | cancelled (merged into 070) | 2026-09-01 | 2026-09-01 |
| 110 | 完成跨 agent 集成审计 | gpt-5.6-sol | cancelled (merged into 070 review) | 2026-09-01 | 2026-09-01 |

## 就绪集与调度

初始就绪叶为 020。020 完成后 010、030、040 可并行；050 等 030；060 汇合 canonical、legacy、
search；随后 070 一次完成 capability、四工具、child profile 与最小文档，110 做最终集成审计。最多三个执行
agent，保留一个 reviewer 槽。每个非机械叶完成后必须由不同 agent 独立复审。

Git HEAD 仍是 rollout 之前的共同基线；reviewer 除 `git diff <base> -- <owners>` 外，还必须读取
`../agent-rollout-storage` final reviews，区分前置工作树与本叶增量。

## 覆盖矩阵

| id | 场景 | owner | 必须证明 |
| --- | --- | --- | --- |
| C01 | global list root/child | 030、110 | 多 conversation、跨原 workspace，稳定排序与分页 |
| C02 | running/terminal | 030、110 | status 与 complete 分离，无错误 partial warning |
| C03 | items/read | 030、080、110 | tombstone、roles、pending、Unicode chunk、输出上限 |
| C04 | legacy root | 040、110 | recovery-only 可读，不创建 store，不伪装 canonical |
| C05 | legacy child | 040、110 | assistant/tool only、坏行隔离、partial warning |
| C06 | search all/target | 050、110 | FTS rank/snippet、role filter、稳定 cursor |
| C07 | search maintenance | 050、110 | item upsert/delete、lag、probe fail、drop/rebuild |
| C08 | server Web | 060、070、110 | HTTP commands 可用；source fatal；static unavailable |
| C09 | CLI direct | 060、070、110 | 共用 rollout driver/executor，无第二查询权威 |
| C10 | root → 任意 target | 080、110 | 四工具注册一次、结果/警告不丢失、无 ACL |
| C11 | child → root/sibling/descendant | 090、110 | 三档 profile 可见且实际 gate 放行，无 approval |
| C12 | 重启与重建 | 050、110 | 五表+FTS 删除后只靠 JSONL 恢复等价查询 |
| C13 | corruption 分类 | 040、060、110 | canonical source fail-closed；legacy 坏行 warning |
| C14 | retention/delete | 100、110 | 本树无删除；旧 trace 可丢；rollout 主记录不触碰 |
| C15 | workspace identity | 100 | 明确不存在；canonical 是全部本机 app-data |

## 验收总门

1. 各叶定向 Vitest、`pnpm exec tsc -b`、`pnpm check:boundaries`、`pnpm check:state`、`git diff --check` 通过。
2. 真实 `node:sqlite` 验证 FTS5 probe、增量 upsert/delete、lag、drop/rebuild 与 feature unavailable。
3. 真实 server host invoke 与 CLI direct assembly 均可执行四方法；static Web 稳定 unavailable。
4. root 与三档 child 均能执行四工具；合法 target 不经过 permission/approval/ancestor 分支。
5. canonical JSONL/source corruption 保持 fail-closed；legacy malformed line 只影响该行并带 warning。
6. 五表及 FTS 删除后，仅靠 JSONL 重建的 list/items/read/search 与删除前深等价。
7. 新增/大改普通文件全部 `<=300`，无 `part1`、`xxx2`、新增大杂烩 `utils`。

## 决策与代价

- 裁决：canonical 查询覆盖全部本机 app-data，不引入 workspace identity。理由是现有 target/catalog 无该字段；
  错了的代价是未来做多租户或 workspace 隔离时要版本化 target/catalog 并迁移。
- 裁决：全部 agent 无 ACL 读取。理由是用户明确要求本地即可信范围；错了的代价是未来共享机器/服务化时需
  在 capability 外新增隔离层。
- 裁决：FTS5 是独立派生索引。理由是全局历史无界增长且 Node executor 同步，全表扫描会阻塞宿主；错了的
  代价是要维护索引版本/watermark 与重建路径。
- 裁决：legacy workspace root 只是隐藏 locator。理由是旧 archive 没有全局 catalog；错了的代价是当前未提供
  root 的旧 workspace trace 不可发现，但不会被误归属或越界扫描。
- 裁决：不新增 retention/delete。理由是 append-only 原始证据的用户可见删除策略尚未设计；错了的代价是
  磁盘持续增长，需要单独任务解决。
