# 树形子 Agent 系统实施蓝图（v1）

本文件给出一套可上线、可并发、可复盘的树形子 agent 设计。对应现有实现位于：

- `src/agentNew/tools/delegate-agent/delegate-agent.ts`
- `src/agentNew/subagents/runtime.ts`
- `src/agentNew/subagents/scheduler.ts`
- `src/agentNew/subagents/path.ts`
- `src/agentNew/subagents/distill.ts`
- `src/agentNew/subagents/replay.ts`
- `src/agentNew/subagents/skillCache.ts`
- `scripts/subagent-replay-report.js`

## 决策先行

- **路径（path）**：沿树使用可读路径 `root-01-02`，不使用 UUID。  
  `root` 为根，子节点按父级递增编号：`root-01`, `root-02`, `root-01-01`。
- **身份（id）与唯一性**：`path` 只用于本次 run 内树定位；真实唯一键使用 `runId` + `skillId`（以及 `runId` 本身区分树）。
- **文件名冲突解法**：run 目录按会话和 run 分区，且 core skill 使用调度批次号（`root.01-core.md`, `root.02-core.md`）避免同路径多轮复用冲突。
- **并发**：`children` 先保留路径后并发生成 skill；再并发执行 child agent。整树共享模型 semaphore，`maxConcurrent` 默认 4、硬上限 8。
- **规模预算**：整树共享总节点与模型调用计数，默认分别为 64/128，硬上限为 256/512；后代只能收紧。
- **工具权限**：child 默认仅可继续委派；显式 `workspace_read` 只增加四个只读 workspace 工具，后代不可扩权。
- **复盘**：所有关键动作写入 append-only 事件流 `events.jsonl`，配快照 `tree.json`，可离线完整回放。

## 核心流程（父派发一次）

1. 父 agent 通过模型调用 `delegate_agent`，模型只提交高层结构化任务（children + strategy）。
2. `runtime.delegateAgents` 通过 `subagentScheduler.reserveChildren(...)` 预分配一批子路径。
3. 一次性并发请求生成：
   - 1 条父 `core` skill（承接上下文、约束、已决策信息）。
   - N 条每个 child 的 `task brief`（可并行失败重试策略）。
4. 双写 skill：
   - run-local：`runs/<runId>/skills/<path>.<batch>-<kind>.md`
   - global 长期库：`.agent-archive/skills/<skillId>.md`
5. 并发运行 child agent，默认仅允许 `delegate_agent`（headless）。每个子 agent 继续复用步骤 1~5 可递归形成树。
6. 运行结束后写入：
   - `nodes/*.json`, `tree.json`, `results/*.result.md`, `events.jsonl`, `run.json`, 索引 jsonl。
7. 复盘脚本读取 `events.jsonl` + 可选 `tree.json` 重建树态、事件计数、子任务结果、失败原因。

## 长期可复盘存储

约定路径（会话级 + run 级）：

```text
.agent-archive/conversations/<conversationId>/runs/<runId>/
```

核心文件：

- `events.jsonl`：全部动作事件（优先源）。
- `tree.json`：最终树快照。
- `nodes/<path>.json`：节点快照。
- `results/<path>.result.md`：子 agent 输出。
- `skills/<path>.<xx>-<kind>.md`：run-local 可读文件。
- `.agent-archive/skills/<skillId>.md`：长期存储的技能内容与元信息。
- `index/agents.jsonl`, `index/skills.jsonl`, `index/runs.jsonl`：检索/增量加载。

## 子agent 并发与递归的控制边界

- `maxChildren` 默认 6，硬上限 12。
- `maxConcurrent` 默认 4，硬上限 8。
- `maxDepth` 默认 2，硬上限 6。
- `maxTotalNodes` 默认 64，硬上限 256，包含 root。
- `maxModelCalls` 默认 128，硬上限 512，覆盖蒸馏与 child turn。
- 子 agent 默认为 headless，不自动拥有写文件类工具。
- 允许子 agent 再次调用 `delegate_agent`，形成 `root -> root-01 -> root-01-01` 的树。

## 分工（架构师派工）

### A. 路径与调度组
- **负责人**：Path + Scheduler
- **任务**：维护 `root-01` 系列路径规则、`dispatchCounter`、`childCounter`，保证同层单调递增且不会复用旧路径。
- **验收**：同一父节点多次派发路径不重复；`root-01`, `root-02` 后续正确生成 `root-03`。

### B. 蒸馏组
- **负责人**：Distill + Skill 命名组
- **任务**：并行生成 core/task brief；失败策略（`parallel_wait_all` / `parallel_best_effort`）；命名规则和 `skillId` 生成。
- **验收**：同路径多轮 core 生成无覆盖；fallback 能返回可读可执行 brief。

### C. 执行组
- **负责人**：Runtime 执行组
- **任务**：child messages loop、tool 白名单（默认仅 delegate）、并发执行、异常失败路径。
- **验收**：子 agent 失败不影响其他子节点；事件能完整写入。

### D. 复盘与观测组
- **负责人**：Replay + 归档组
- **任务**：`replaySubagentArchive` + CLI 报告；增加 parse-error 标记与节点树排序规则。
- **验收**：给定事件流可回放出节点状态、child 结果和异常列表。

### E. 交付组
- **负责人**：文档与治理组
- **任务**：维护 `.md` 设计文档、运行手册，建立命名/目录约定与清理策略。
- **验收**：新增对话可直接按会话+run 复盘，不再依赖内存状态。

## 即刻交付清单（v1）

1. 完成并验证 `delegate_agent` 调用链（已完成）
   - 输入归一化、路径预留、并发子 agent 启动。
2. 完成长生命周期档（已完成）
   - 事件流、树快照、nodes、results、skill 索引。
3. 完成离线复盘脚本（已完成）
4. 建立回放文档、索引压缩工具与操作手册（已完成第一版）
5. UI 同时展示对话内实时委派批次和 archive 驱动的完整递归树，并支持 result/event log 预览（已完成）
6. workspace 全局历史 run 浏览（含 fingerprint 稳定分页）、跨进程归档锁、自动索引压缩与治理崩溃恢复（已完成）

## 已落地能力

- 现成的路径模型（`root-01-01`）和多轮 `core` 命名防冲突。
- `run` 级隔离使同一会话中多次调用可独立，不会互相覆盖。
- 长期 skill 通过 `skillId` 定位；candidate 已支持确定性可解释评分、复盘检索，以及人工确认后生成“尚未执行”的治理 CLI。UI 不直接 mutation，promotion/archive 的锁、journal 与 audit 仍由治理 CLI 负责。
