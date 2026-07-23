# 树形子 Agent 系统实施方案

**目标**：基于现有 `agentNew` 能力，给出一套可以长期复盘、可并发、可递归派发的树形子 agent 落地方案。

## 结论先行（直接回答你的问题）

1. `path` 用 `root-01-02` 这种数字树路径，不用 UUID。
2. `uuid`/`skillId` 用于**长期唯一身份**（`skill_id`）。`path` 用于可读性和树定位。
3. 同一次 `delegate_agent` 调用不会因同路径覆盖：`distill` 的核心 skill 用 `dispatch index` 做文件名，变成 `root.01-core.md`、`root.02-core.md`。
4. 复盘用 `.agent-archive/...` 的事件流和快照来重放，不依赖内存状态。

## 现有实现映射（已可用）

已实现组件如下：

- 输入标准化：[normalizeDelegateAgentInput](/Volumes/work/ai/web-agent/src/agentNew/subagents/input.ts)
- 树路径规则：[path.ts](/Volumes/work/ai/web-agent/src/agentNew/subagents/path.ts)
- 子树调度：[scheduler.ts](/Volumes/work/ai/web-agent/src/agentNew/subagents/scheduler.ts)
- 技能蒸馏：[distill.ts](/Volumes/work/ai/web-agent/src/agentNew/subagents/distill.ts)
- runtime 与并发执行：[runtime.ts](/Volumes/work/ai/web-agent/src/agentNew/subagents/runtime.ts)
- `delegate_agent` 工具：[delegate-agent.ts](/Volumes/work/ai/web-agent/src/agentNew/tools/delegate-agent/delegate-agent.ts)
- 归档与回放：[replay.ts](/Volumes/work/ai/web-agent/src/agentNew/subagents/replay.ts)

## 核心工作流

1. 父 agent 决定派发 → `delegate_agent`。
2. `toolContext` 把继承 skills 与 transcript 透传给 `DelegateAgentRuntime`。
3. `scheduler.reserveChildren` 为父节点一次性预分配一批子路径（如 `root-01`、`root-02`）。
4. 运行一次并发 AI 请求：
   - 1 条 core skill（父上下文）
   - N 条 child brief（每个子任务）
5. 所有 skill 写入 run 本地目录与全局目录。
6. 以根调用的 `maxConcurrent` 作为整棵树的模型请求并发上限；子树只能主动收紧。
7. 子节点执行时可再次触发 `delegate_agent`。
8. 运行结束后持久化 `events.jsonl`、`tree.json`、`nodes/*.json`。

## 并发与可重放策略

- 整棵树共享模型调用 semaphore；批次仍通过 `runWithConcurrency` 控制派发，避免父节点等待递归子树时占用许可造成死锁。
- 根调用锁定 `maxDepth`、`maxChildren`、`maxConcurrent` 预算，后代调用和 child 级配置只能取更小值，不能放大根预算。
- `children_reserved` 写入 `dispatchCounter`，用于识别同一父节点的第几批派发。
- 归档为 append-only 事件，配合节点快照可进行幂等重建；仅使用事件流也能收尾 root/parent 状态。
- 取消会落为 `cancelled`，蒸馏失败会收口预留节点并尽力写入最终事件和快照。

## 文件命名与唯一性

- run 本地目录按会话+run 分离：
  - `.agent-archive/conversations/<conversationId>/runs/<runId>/skills/...`
- run 内 skill 文件名：`<path>.<dispatch>.md`
  - core：`root.02-core.md`
  - child brief：`root-01.01-task-brief.md`
- 全局持久 skill 身份使用 `skill_id`（不会依赖文件名）。
- 由于目录以 runId 隔离，即使多次对话也不会相互覆盖。

## `dispatchCounter` 语义（最新版）

- 存在于 `SubagentNodeRecord.dispatchCounter`。
- 含义：某个父节点已经执行了几次批量派发（1,2,3...）。
- 子节点创建时保持 `0`，避免继承污染父节点语义。
- `distill` 的父核心 skill 文件名和 skillId 采用该值。

## 子agent分工建议（可直接“派活”）

**Agent-Path（路径管控）**
- 负责：`path.ts` 与 `scheduler.ts`，验证路径合法、`parent.childCounter` 边界、批次计数测试。
- 验收：新批次不会复用路径，`dispatchCounter` 仅父节点增长。

**Agent-Distill（内容管控）**
- 负责：`distill.ts`，并行蒸馏提示词、fallback brief、`coreDispatchIndex` 影响命名。
- 验收：多轮派发 root 的 core 不会覆盖；child brief 始终可复用 `path-01` 语义。

**Agent-Runtime（执行管控）**
- 负责：`runtime.ts` 与工具链，保证并发上界、子 agent 只能调用 `delegate_agent`。
- 验收：`nested_delegate_requested` 不越界，任务树正常递归。

**Agent-Replay（复盘）**
- 负责：`replay.ts` 与展示联动，形成可搜索事件索引。
- 验收：给定 `events.jsonl` + 可选 `tree.json` 可恢复完整节点快照和 child result。

## 落地计划（从现在到可上线）

1. 核心稳定性（已完成）：首次归档 upsert、失败显式传播、根预算不可放大、全树模型并发上限、取消/蒸馏失败收口。
2. 回放一致性（已完成）：snapshot + events 幂等合并、完整 child result、`cancelled`、events-only parent/root 收尾；TS 与 CLI 行为一致。
3. 可运维（已完成）：重要事件已进入 append-only 索引；回放 CLI 支持 run/events 输入；索引压缩 CLI 默认 dry-run，按逻辑 key 保留最新记录并支持原子替换。archive 写入按目标路径进程内串行，并与压缩 CLI、skill 治理共用跨进程目标锁；三类索引达到 128 KiB 后自动压缩，坏数据 fail-closed，events 保持 append-only。
4. 产品化（已完成）：对话 UI 同时展示实时委派批次、archive replay 完整递归树和 workspace 全局历史 run，并提供节点 result/event log 预览入口；同一 run 的多批委派使用 tool call id 隔离。归档与预览读取带请求令牌和节点归属校验，切换 run、workspace 或节点时不会被旧请求覆盖。全局 runs 索引使用文件尾优先的专用分页命令，跨页去重保留最新记录，cursor 绑定文件 fingerprint；append/压缩导致快照变化时 fail-closed，超过通用读取 200 KiB 上限的唯一历史也不会被截断。`workspace_read` 只读 profile 已接入并保持后代只可收紧。
5. 规模化（主体已完成）：整棵树共享 `maxTotalNodes` 与 `maxModelCalls`，后代不能放大，并在结果/事件中返回用量。skill/agent index 合批 flush 和 dispose drain 已实现。
6. Skill 治理（已完成）：candidate 默认只读；确定性评分逐项解释来源证据、摘要信息量、继承链路和内容身份，但不会自动迁移。UI 要求显式人工确认，确认后仅准备并显示“尚未执行”的审计 CLI；实际 promotion/archive 仍必须显式指定 skillId 与 `--write`。完整索引/frontmatter/audit 校验、合法单向迁移、统一目标写锁、预写 journal、崩溃恢复和独立审计均已实现；异常目标漂移会 fail-closed。

## 当前完成度（2026-07-21 review）

- 核心 runtime、递归并发、安全收口：本轮范围 100%。
- 归档、回放与索引运维：本轮范围 100%。
- UI 与日常可操作性：本轮范围 100%（实时批次、全局历史、完整递归树、result/event 预览及 skill 评分/确认 UI 均已具备）。
- 综合可上线完成度：本轮定义范围 100%。原剩余的危险工具范围化确认继承、`parallel_best_effort` 细粒度状态/汇总、candidate skill 评分/人工确认 UI，以及超大唯一 run 索引稳定分页均已完成并回归通过。

## 直接答案总结

你现在可以把 `path` 继续保留为 `root-01-01`；文件重复问题的关键不在 path，本地 run 目录 + `dispatchCounter` 已经处理。`skillId` 才是跨 run 的长期身份。

> 需要更完整的执行分工与验收清单，请看：[树形子 Agent 系统实施蓝图（v1）](/Volumes/work/ai/web-agent/docs/tree-subagent-architecture-blueprint.md)
