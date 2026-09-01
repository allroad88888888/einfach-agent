# Local agent history tools 重基线审查

VERDICT: REBASE_REQUIRED

## 结论

旧树不能原样解阻。rollout 树已交付一份跨 root/child、跨 Web/CLI、位于全局 application-data 的
append-only JSONL 主记录及 SQLite 五表投影；旧 020 再建 child `history/*.items.jsonl`、旧 030 从内存
root snapshot 与 workspace archive 拼查询、旧 060 把主历史纳入 workspace retention，都会形成第二权威。
应删除 020，重写 030/040/060/070，保留但重基线 010/050；读侧以 rollout 投影为正常路径，以旧 root
recovery snapshot 和旧 child trace 为只读兼容源。

范围裁决也必须改为：**全部本机 app-data 历史**。不需要 workspace identity；当前 target、catalog、路径和
record 均没有 workspace 字段，事后用 cwd 推断会产生错误归属。所有 agent 可读，不增加 ACL、caller identity、
ancestor 判断、批准或遮罩。

## Findings

### Critical

1. **重复 child persistence。** 旧 020 要另建 workspace `history/<agent>.items.jsonl` 并重复 initial、assistant、
   tool、synthesis 强写（`020-durable-child-history.md:30-75`）。现有 recorder 已把同一完整模型流写入统一
   driver，并以 `conversationId/runId/agentPath` 建 target（`packages/agent-core/src/subagents/childRolloutRecorder.ts:30-82`）；
   rollout 终审确认写入点与 fence 完整（`agent-rollout-storage/reports/final-review.md:30-33`）。020 应删除。

2. **root 查询权威失效。** 旧 030 指定查询 hydrate 的 `ConversationItem`（`030-local-history-query.md:31-56`），
   但 rollout 已把 root delta 写入同一证据流，SQLite `agent_rollout_items` 是可重建查询投影
   （`packages/host-node/src/rollout/projector.ts:98-164`）。正常 root 查询不得依赖当前进程已 hydrate store；
   recovery SQLite snapshot 只能作为“尚未 backfill 的 legacy root” fallback，返回不完整 warning。

3. **workspace-local 与 global catalog 冲突。** 旧 index 固定“当前工作区、不跨工作区扫描”
   （`local-agent-history-tools/index.md:25-40`），而 canonical source 从 application-data 下全部发现
   （`packages/host-node/src/rollout/sourceCatalog.ts:23-43`），app-data 是平台全局目录
   （`packages/host-node/src/appDataPath.ts:12-35`）。合同没有 workspace identity，不能维持旧范围承诺。

### Important

1. **owner/装配层错误。** 旧 030 把 Node fs 查询放在 `packages/subagents`，旧 040 从 delegation runtime
   提供能力（各 leaf frontmatter/`040-history-runtime-capability.md:42-57`）。正确边界是：core `/history`
   拥有纯合同；host-node 拥有 SQLite/legacy I/O 与查询 service/routes；Web 使用 HTTP host adapter；CLI
   使用同一个 Node query service/executor；ToolContext 仅持 transport-neutral capability。现有 rollout 已证明
   server adapter、CLI borrowed shared driver 与启动 reconcile 边界
   （`agent-rollout-storage/reports/final-review-2.md:50-57`）。

2. **旧 retention 验收无效。** 旧 060 围绕 `.webAgent-archive` export/prune/restore
   （`060-retention-legacy-docs.md:24-48`）；全局 rollout 当前明确无删除 API，JSONL 不被 rebuild/drop 触碰
   （`projectionSchema.ts:71-75`，`agent-rollout-storage/index.md:166-173`）。本树只需记录 legacy reader 与“不提供
   删除/retention”的文档，不应修改 workspace retention script。

3. **`complete` 含义原先混合“终态”与“内容覆盖”。** 五表 catalog 的 `complete` 只在 run status 为
   done/stopped/error 时置真（`projector.ts:137-151`）；legacy trace 即使 run 已结束仍缺 system/user。公共结果应同时
   返回 `complete`（该可见历史是否由完整 rollout 且已终态）和 `status`；运行中 rollout 为 `complete:false`
   但无“不完整源”warning，legacy 永远 false 并带 `LEGACY_PARTIAL_HISTORY`。否则调用方无法区分“仍运行”与“缺数据”。

4. **cursor 不能继续按文件 snapshot 自造。** 正常读侧应基于五表的 `last_rollout_ordinal` 与
   `projection_state.next_byte_offset/next_rollout_ordinal`（`projectionSchema.ts:12-63`）。cursor 必须绑定查询种类、
   规范化 filter/query、投影 snapshot 和最后 sort key；任一不匹配返回稳定 `AGENT_HISTORY_CURSOR_STALE`，不静默续页。

### Minor

1. 010 的拆分仍必要：`tools/types.ts` 当前正好 299 行，且 `ToolContext` 仍在其中
   （`packages/agent-core/src/tools/types.ts:152-162`）。但 owner 应只做机械拆分，不预埋历史实现。
2. 临界文件仍在：`childAgentToolCalls.ts` 292、`childAgentLoop.ts` 294、rollout `projector.ts` 287 行；新查询、
   tool gate、FTS 职责不得追加到这些文件。rollout projector 只保持五表 owner，搜索索引另文件。

## 应复用的既有合同与边界

- 直接复用 `AgentHistoryTarget`，不要新增 archive path 或 workspace 字段
  （`agentHistoryTarget.ts:1-8`；逻辑 target 到 hash path 的唯一映射见 `rolloutPath.ts:15-39`）。
- JSONL 是证据，SQLite 是可重建读模型；复用 catalog/events/items/turns/projection_state 五表，不再建第二份
  transcript 表（`projectionSchema.ts:3-64`）。查询前由装配层 reconcile；source warning fail closed，projection
  warning 可报告 lag（`service.ts:175-197`、`apps/web/src/main.tsx:140-143`）。
- core 公共面继续是 `@einfach-agent/core/history`（`packages/agent-core/package.json:57-60`）；host-node 已是
  Node SQLite 与 rollout service owner（`packages/host-node/src/index.ts:98-116`）。static Web 没有本机文件能力时
  capability 缺席并返回 `AGENT_HISTORY_UNAVAILABLE`，不得偷偷扫描 browser IndexedDB。

## 四工具建议公共合同

统一 capability 仍为 `listHistories/listItems/readItem/search`。所有返回包含 `warnings: AgentHistoryWarning[]`；
warning 至少区分 `LEGACY_PARTIAL_HISTORY`、`PROJECTION_LAG`、`MALFORMED_LEGACY_RECORD`。逻辑 target 原样返回。

- `list_agent_histories({cursor?,limit?})`：默认 20、最大 100；按 `updatedAt DESC, historyId ASC`；返回 target、
  title、status、complete、itemCount、first/last timestamp。
- `list_agent_history_items({target,cursor?,limit?,roles?})`：默认 20、最大 100；按 `itemOrdinal,itemId`；跳过
  deleted，preview 最多 2,000 字符，保留 itemId/role/createdAt/pending。
- `read_agent_history_item({target,itemId,offset?,maxChars?})`：offset 为 Unicode code-point offset；默认/最大
  20,000 字符；返回 `content,nextOffset|null,totalChars,complete,warnings`。item 不存在与已删除使用稳定 code。
- `search_agent_histories({query,target?,cursor?,limit?,roles?})`：trim 后 1–1,000 字符；默认 20、最大 50；
  snippet 最多 1,000 字符；按 rank、updatedAt、historyId、itemOrdinal 稳定排序。

cursor 是 versioned base64url JSON 后再做完整 shape 校验，不是安全令牌。列表/搜索每页整体序列化上限建议
100,000 字符；达到上限提前截断并返回 cursor + `OUTPUT_TRUNCATED`。单 item JSON 解码也必须设字节上限，不能让
preview/read 的字符上限掩盖超大分配。

语义矩阵：正常 root/child rollout 运行中 `complete:false,status:running/...`、无 partial warning；终态
done/stopped/error 为 `complete:true`；legacy root recovery snapshot 和 legacy child trace 均
`complete:false,status:'legacy'` 并说明可见/缺失面。畸形 legacy 行跳过并 warning；canonical rollout source
损坏不是“尽量读”，而是 source error，保持 rollout 的 fail-closed 合同。

## Search v1 裁决

选择 **FTS5 派生索引**，不选全局受限扫描。当前运行时是 Node 24.14，`node:sqlite` 内置 SQLite 3.51.2；
实测 `sqlite_compileoption_used('ENABLE_FTS5')=1` 且可创建 `fts5` virtual table。更重要的是全局 app-data 会无界增长，
`node:sqlite` 的执行面同步（`packages/host-node/src/sqlite/nodeSqliteExecutor.ts:92-95`）；每次 search 扫描
`agent_rollout_items.item_json` 即使 limit 50 也会阻塞 host event loop，不能作为正式 v1。

FTS 表应命名为独立的 `agent_history_search_fts`，由新的 search-index owner 管，不改 rollout 五表的语义；以
`history_id + item_id` 为外部身份，索引从 `agent_rollout_items` 中 `deleted=0` 的 ModelItem 可搜索文本派生。
它是第六张**可删除派生索引**，不是第六张 rollout 投影权威。首次启动/版本不匹配/离线 rebuild 后可从五表
重建；item upsert/delete 后同步维护，失败返回 `SEARCH_INDEX_UNAVAILABLE`，不得回退无界扫描或影响 JSONL append。

失败模式与 owner：FTS5 不可用或 schema/version 错误由 host query startup 报 capability unavailable；索引落后由
search-index watermark 对比五表 catalog/projection watermark，先 bounded catch-up，仍不一致返回
`PROJECTION_LAG`；损坏时只 drop/rebuild FTS 表。rollout `projectionSchema/projector/rebuild` 仍只 owner 五表与
JSONL 重建；search leaf owner FTS schema、text extraction、rebuild hook。测试不得假设所有未来 SQLite build 都有
FTS5，必须覆盖 feature probe fail。

## 建议的新任务树

所有 leaf 以当前 rollout 完成态为新 base，目标 10–20 分钟闭环；普通文件均 <=300 行。

| 新 leaf | model | depends | 单一目标与 owner 文件 | 旧叶处置 |
| --- | --- | --- | --- | --- |
| 010 ToolContext split | gpt-5.6-terra | 无 | `tools/context.ts`,`tools/types.ts`,`tools/index.ts`：只拆合同 | 010 重基线保留 |
| 020 History query contract | gpt-5.6-sol | 无 | `history/historyQuery.ts`,`history/index.ts` + contract tests：四方法 DTO、limits、cursor/error/warning 类型 | 旧 020 删除；旧 030 合同部分迁入 |
| 030 Rollout read repository | gpt-5.6-sol | 020 | host-node 新 `rollout/queryRepository.ts`,`queryCursor.ts` 及测试：只查五表、snapshot/keyset、bounded read | 旧 030 全重写 |
| 040 Legacy adapters | gpt-5.6-sol | 020 | host-node 新 `historyLegacyRoot.ts`,`historyLegacyChild.ts` 及 fixtures：只做 snapshot/trace fallback 与 partial warnings | 从旧 030/060 拆出 |
| 050 FTS search index | gpt-5.6-sol | 020,030 | host-node 新 `rollout/searchSchema.ts`,`searchText.ts`,`searchIndex.ts` 及测试：probe、维护、重建、rank | 新增 |
| 060 Query service/routes | gpt-5.6-sol | 030,040,050 | host-node 新 `historyQueryService.ts`,`historyCommands.ts`；command names/tests：组合正常/legacy、reconcile/warnings | 旧 040 查询装配部分重写 |
| 070 Web/CLI capability assembly | gpt-5.6-sol | 010,060 | core `tools/context.ts`；Web server adapter；CLI persistence/runtime：每宿主一个 query capability，共用现有 executor/lifecycle | 旧 040 其余重写 |
| 080 Four tools | gpt-5.6-terra | 020,070 | tools/agents 四个既有“一目录一实现/guide/test” + agents registry；每文件只负责一个工具 | 旧 050 重基线保留 |
| 090 Child visibility gate | gpt-5.6-terra | 080 | `subagents/historyToolProfile.ts`、`toolProfile.ts`、delegation capability tests：四工具供三档 safe introspection | 从旧 040 单独拆出 |
| 100 Legacy/global docs | gpt-5.6-terra | 040,080 | 新 `docs/agent-history-tools.md`：global app-data、legacy partial、无 ACL、无 retention/delete | 旧 060 删除 retention 修改并重写 |
| 110 Integration audit | gpt-5.6-sol | 090,100 | 新分场景 integration tests（单文件预计超 300 时按 query/assembly/search 场景拆）与 report | 旧 070 重写 |

030 与 050 不应同时改 `projector.ts`；若需要 append 后更新 FTS，由 050 暴露具名 search-index projector，再由
060 在 query-owned catch-up/reconcile 边界调用，避免把第六表塞入 287 行 rollout projector。070 不应把查询能力
挂在 `DelegationRuntime`：root/child 共享同一 ToolContext capability，090 只负责 child tool-name gate。

## 覆盖矩阵与最终验收

| 场景 | owner |
| --- | --- |
| global list：多 conversation、root/child、跨原 workspace | 030/110 |
| root/child running 与 terminal 的 status/complete | 030/110 |
| legacy root snapshot、legacy child trace、坏行 partial warning | 040/110 |
| items keyset、append 后 stale cursor、deleted/pending/roles | 030/110 |
| read Unicode offset、20k chunk、超大/不存在 item | 030/080 |
| FTS target/all、rank、snippet、delete/upsert、重建、probe fail/lag | 050/110 |
| Web server route、CLI direct shared executor、static unavailable | 060/070/110 |
| root、delegate_only、workspace_read、workspace_verify 均可调用；无 ACL 分支 | 090/110 |
| registry 唯一、四工具 replay-safe、总输出 100k 截断 | 080/110 |
| drop 五表 + FTS 后仅靠 JSONL 重建；legacy 不被伪写回 | 050/110 |

最终门：定向与全仓 Vitest、`pnpm exec tsc -b`、`pnpm check:boundaries`、`pnpm check:state`、
`git diff --check`；真实 `node:sqlite` FTS5 测试；真实 server invoke 与 CLI assembly 测试；删除五表和 FTS 后重建
深等价；source corruption fail-closed、projection/search-index 故障分类不反转；扫描生产代码确认没有
`permission|approval|historyScope|ancestor` 的历史访问分支；新增/大改普通文件 `wc -l <=300`，不允许把职责塞入
现有 292/294/287 行临界文件。
