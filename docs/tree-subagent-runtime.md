# 树形子 Agent Runtime

本文记录 `@web-agent/core` 树形子 agent 核心实现，以及长期复盘 archive 的约定。

## 目标

- 父 agent 可以通过 `delegate_agent` 一次派发多个 headless 子 agent。
- 子 agent 可以继续调用 `delegate_agent`，形成 `root -> root-01 -> root-01-01` 的树。
- 派发前 runtime 会并行请求模型，把父 agent 的核心思路和当前对话蒸馏成 skills。
- 子 agent 启动时继承父节点 skills，再叠加自己的 task brief。
- 每次派发都会写入长期 archive：树、节点、skills、结果、事件流和索引，便于复盘。

## Path、Id 与 SkillId

结论：**逻辑树地址用 `root-01-01` 数字 path；执行身份保留 opaque id；长期 skill 引用用 `skillId`。**

- `agentPath`：本 run 内的树位置，短、稳定、可读，适合模型、文件名、树展示和人工排查。
- `node.id`：执行身份，当前为 `<runId>:<agentPath>`，后续可扩展 attempt/nonce。
- `skillId`：长期唯一 skill 身份，写入 frontmatter 和索引，跨文件、跨复盘引用都用它。

当前 path 规则：

- 根节点固定为 `root`。
- 第 N 个子节点为 `<parent>-NN`，从 `01` 开始。
- 示例：`root`、`root-01`、`root-02`、`root-01-01`。
- 模型不能传入 path/id，全部由 runtime 分配。

实现入口：

- [path.ts](../packages/agent-core/src/subagents/path.ts)
- [scheduler.ts](../packages/agent-core/src/subagents/scheduler.ts)

## 长期 Archive

归档目录：

```text
.agent-archive/
  conversations/
    <conversationId>/
      conversation.json
      runs/
        <runId>/
          run.json
          events.jsonl
          tree.json
          skills/
            root.01-core.md
            root-01-task_brief.md
          nodes/
            root.json
            root-01.json
          results/
            root-01.result.md
  skills/
    <skillId>.md
  index/
    runs.jsonl
    skills.jsonl
    agents.jsonl
```

说明：

- run-local skill 文件名保持 `root-01-task_brief.md` 或 `root-01-01-task_brief.md`，用于人工阅读。
- global skill store 使用 `.agent-archive/skills/<skillId>.md`，用于长期引用和检索。
- `events.jsonl` 是 append-only 事件流，用于复盘派发、蒸馏、子 agent 启停和结果。
- `index/*.jsonl` 是状态索引流；同一 run/node 可能出现多条状态记录，消费方按 key 取最后一条。根 run 启动时写入 `running`，完成时再写入最终 `delegated` 状态，避免全局列表长期停留在运行中。
- 进程内 archive writer 按目标路径串行化写入，避免同一路径并发 overwrite/append 乱序；高频 `index/*.jsonl` append 在同一 microtask 内合并后 flush。跨进程写入还会获取目标文件旁的 `.archive-write.lock`：等待上限 10 秒、每 5 秒续租、30 秒无续租可回收；超时或锁异常会显式返回写入失败。CLI 索引压缩和 skill 治理写入共用同一锁协议。
- 三个状态索引 `runs.jsonl`、`agents.jsonl`、`skills.jsonl` 达到 128 KiB 后会在持锁期间自动去重压缩，压缩频率最多每 5 分钟一次，单文件安全上限为 16 MiB。坏行或替换失败会在本次 append 前显式失败并保留原索引；`events.jsonl` 永远不参与自动压缩或合批，继续保持逐事件 append-only。
- runtime 正常、失败和取消收尾都会等待 archive 写入；`dispose()` 会执行最终 flush/drain。取消信号不阻止最终审计落盘，但 stale run（已被新 run 顶替）仍由宿主写入守卫拒绝，flush 失败会显式传播。
- writer 关闭时会旁路记录 `subagent.archive_write_summary` trace span，含 `archive_write_attempts`、`archive_write_failures` 与 `archive_write_failure_rate`。计数口径是实际交给宿主的落盘批次（索引 microtask 合批计为一次），不写回 archive，也不改变 append-only 事件流。
- 索引可用 `pnpm subagent:index:compact` 预览去重，再用 `pnpm subagent:index:compact -- --write` 原子压缩。逻辑 key 分别为 run=`conversationId+runId`、agent=`conversationId+runId+path`、skill=`skillId`；坏行会中止全部写入。压缩只处理 `index/*.jsonl`，不会读取或改写 append-only 的 `conversations/**/events.jsonl`。
- archive 容量治理使用 `pnpm subagent:archive:retention`：默认只报告当前归档大小；带 `--max-bytes` 会按最早 completed run 预览可回收的派生文件。真正清理必须同时提供外部 `--export <directory>` 和 `--write`；先复制并逐文件校验 SHA-256，再删除 `tree.json`、`nodes/`、`results/`、`traces/`、run-local `skills/`。`events.jsonl` 与 `run.json` 永远保留在 live archive，且不会被覆盖。
- `pnpm subagent:archive:retention -- --export <directory> --conversation <id> --run <id> --write` 可以导出完整的已完成 run（含事件流）；`--restore <directory> --write` 只接受前述 prune 导出包，恢复缺失的派生文件并拒绝覆盖已有内容。所有 export/prune/restore 生命周期都 append 到 `.agent-archive/governance/retention-actions.jsonl`，导出目录不得位于 `.agent-archive` 内。
- `.agent-archive/` 和旧 `.agent-cache/` 都已加入 `.gitignore`。

实现入口：

- [skillCache.ts](../packages/agent-core/src/subagents/skillCache.ts)
- [distill.ts](../packages/agent-core/src/subagents/distill.ts)

## Skill Frontmatter

每个蒸馏出的 skill 都带长期元数据：

```yaml
---
skill_id: "sk_..."
conversation_id: "..."
run_id: "..."
agent_path: "root-01"
kind: "task_brief"
filename: "root-01-task_brief.md"
content_hash: "h64:..."
created_at: "2026-07-09T..."
inherits: []
inherit_skill_ids:
  - "sk_..."
source:
  parent_agent_path: "root"
  parent_skill_ids:
    - "sk_..."
  transcript_chars: 1234
ttl: "permanent"
promotion: "candidate"
---
```

当前生成的 skills 默认是 `ttl: permanent`、`promotion: candidate`：会长期归档，但不会自动成为全局常驻上下文。UI 会对通过完整 index/frontmatter 校验的 candidate 做确定性 100 分制排序，并逐项解释来源证据、摘要信息量、继承链路和内容身份；评分仅辅助人工判断，不会自动改变状态。治理流程只接受人工显式操作：

```bash
# 默认只读：列出当前 candidate；加 --json 可供脚本读取
pnpm subagent:skills
pnpm subagent:skills -- --json

# 变更必须同时给出唯一 skillId 和 --write
pnpm subagent:skills -- --promote sk_xxx --write
pnpm subagent:skills -- --archive sk_xxx --write
```

UI 中的 Promote/Archive 确认只生成上述审计 CLI，并明确标记“操作已生成，尚未执行”。UI 不直接写 archive，也不假设打包环境存在 Node；实际变更仍由操作者在目标 workspace 终端执行，事务锁、journal 和 audit 的唯一所有权留在治理脚本。

需要操作其他 workspace 时使用 `--base <workspace>`。允许的单向迁移为 `candidate -> promoted`、`candidate -> archived` 和 `promoted -> archived`；不支持回退或重复迁移。命令会先完整解析 skills index，并验证 index 与全局 skill frontmatter 的 `skill_id`、`promotion` 一致；任何坏行或不一致都会 fail-closed，不写文件。写入时先持有治理锁，再按稳定路径顺序获取与 runtime 相同的 `<target>.archive-write.lock`，覆盖全局 skill、skills index 和独立 audit，避免跨进程追加与治理替换互相覆盖。

三文件变更使用 `.agent-archive/governance/skill-transaction.json` 预写事务 journal。`prepared`/`committing`/`rolling_back`/`rolled_back` 在下次 mutation 时幂等回滚，`committed` 幂等前滚；每一步都通过 fsync 后的同目录临时文件替换持久化。恢复前会重新校验完整 index、frontmatter、audit、合法迁移和 previous/next 快照；目标出现事务之外的内容时拒绝覆盖。由此 `.agent-archive/governance/skill-actions.jsonl` 的每个人工动作在恢复后恰好保留一条，不会因重放重复或丢失。

## 派发流程

1. root 模型通过 lazy tools 请求并调用 `delegate_agent`。
2. `delegate_agent` 归一化输入，调用 `ToolContext.delegateAgents`。
3. root `modelRun` 为当前 run 创建 `DelegateAgentRuntime`，透传模型设置、apiKey、signal、fetch。
4. runtime 初始化 `.agent-archive/conversations/<conversationId>/runs/<runId>/`。
5. scheduler 为同一批 children 同步预留 path。
6. runtime 并行发起多条 AI 请求：
   - 1 条生成父节点 core skill。
   - N 条生成每个 child 的 task brief skill。
7. 每个 skill 双写：
   - run-local：`runs/<runId>/skills/<agentPath>.<ordinal>-<kind>.md`
   - global：`.agent-archive/skills/<skillId>.md`
8. runtime 按 `maxConcurrent` 并发运行子 agent。
9. 子 agent 默认只允许 `delegate_agent`，可继续分裂下一层；显式 `workspace_read` 时可使用受宿主守卫的只读 workspace 工具；`workspace_verify` 再加 `run_verification_command`，可执行验收所需的 shell 命令和项目脚本。
10. 子 agent 结束后写 result、node、tree snapshot、events 和 indexes。
11. 父 agent 收到 `DelegateAgentBatchResult`，包含 `archiveBasePath`、`eventLog`、`skillIds`、children 结果等。

核心入口：

- [delegate-agent.ts](../tools/agents/src/delegate-agent/delegate-agent.ts)
- [runtime.ts](../packages/agent-core/src/subagents/runtime.ts)
- [toolContext.ts](../packages/agent-core/src/runtime/toolContext.ts)
- [modelRun.ts](../packages/agent-core/src/runtime/modelRun.ts)

## `delegate_agent` 输入

```ts
interface DelegateAgentInput {
  children: Array<{
    objective: string
    mode?: string
    expectedOutput?: string
    maxDepth?: number
    maxChildren?: number
    maxTurns?: number
    toolProfile?: 'delegate_only' | 'workspace_read' | 'workspace_verify'
    confirmedTools?: Array<'shell_macos' | 'shell_linux' | 'shell_powershell' | 'write_file' | 'apply_patch'>
  }>
  strategy?: 'parallel_wait_all' | 'parallel_best_effort'
  maxDepth?: number
  maxChildren?: number
  maxConcurrent?: number
  maxTotalNodes?: number
  maxModelCalls?: number
  toolProfile?: 'delegate_only' | 'workspace_read' | 'workspace_verify'
  confirmedTools?: Array<'shell_macos' | 'shell_linux' | 'shell_powershell' | 'write_file' | 'apply_patch'>
}
```

归一化边界：

- `children` 必须非空。
- 默认 `maxChildren = 6`，硬上限 `12`。
- 默认 `maxConcurrent = 4`，硬上限 `8`；根调用锁定整棵树的模型请求并发上限，嵌套调用只能降低本分支并发。
- `maxDepth` 与 `maxChildren` 同样沿树只允许收紧，子 agent 不能通过嵌套参数放大根预算。
- 默认 `maxDepth = 2`，硬上限 `6`。
- 子 agent 默认 `maxTurns = 4`，硬上限 `8`。
- 整树 `maxTotalNodes` 默认 `64`、硬上限 `256`，包含 root；所有后代共享计数且只能收紧上限。
- 整树 `maxModelCalls` 默认 `128`、硬上限 `512`，覆盖 core/brief 蒸馏和 child turn；取得并发许可后、真正请求模型前计数。
- `toolProfile` 默认 `delegate_only`；`workspace_read`、`workspace_verify` 可在批次或 child 级显式启用，后代只能继承或收紧。
- 与预算不同，root 级委派的档位不沿 run 累积：同一 runtime 的每次 root 调用各自决定档位（省略即 `delegate_only`），
  收窄校验只作用于后代。模型的只读调研批次不会因此挡住随后由 `submit_stage_result` 拉起的 `workspace_verify` 评估器。
- `confirmedTools` 默认空，批次和 child 均只能显式请求宿主签发 capability 的子集；省略不会继承。

实现入口：

- [input.ts](../packages/agent-core/src/subagents/input.ts)

## 权限模型

当前 MVP 采用保守策略：

- root 仍使用现有 lazy tool 体系。
- child 的 tool manifest 使用 `buildTurnTools(..., { allowedToolNames })` 过滤。
- child 默认只允许请求/调用 `delegate_agent`。

### 子 agent 工具 profile（已接入）

- `toolProfile` 必须显式选择，默认 `delegate_only`；可选 `workspace_read`、`workspace_verify`。
- `delegate_only` 白名单仅含 `delegate_agent`；`workspace_read` 只增加 `read_file`、`list_files`、`search_files`、`rg_search`，严禁 shell、write、patch、task 和 git 写操作。
- `workspace_verify` = `workspace_read` + `run_verification_command`：可执行验证所需的 shell 命令，让核验型子 agent 自己取得执行证据；它仍然不能写文件，也拿不到通用 shell。
- profile 是全序能力阶梯 `delegate_only ⊂ workspace_read ⊂ workspace_verify`：后代只能继承或收紧，不能自行放宽。
- root 的档位由宿主每次调用现给，不由上一次 root 调用遗留；模型经 `delegate_agent` 最高只能请求 `workspace_read`，
  `workspace_verify` 需要由宿主在调用时显式给出。
- child 不直接持有文件桥。宿主通过 `DelegateAgentCallContext.runChildTool(name, args)` 转发到完整 `ToolContext`，复用 workspaceRoot confinement、stale/runId、AbortSignal 和 registry 白名单守卫。
- 工具结果仍以普通 tool message 回填，并写入仅含名称、耗时、成功状态的审计事件；不得把文件正文复制进 archive event。
- shell、write、patch、ask_user、browser 等工具不会自动下放给 child。
- 危险工具确认采用宿主 capability：同时绑定 `sessionId`、`runId`、当前 `delegate_agent` call id 与 parent path，runtime 对四项独立校验；模型输入只能请求 capability 中的子集。
- session 的“一律允许”集合不会整体变成 child 白名单。只有本次调用显式列出且 session 已确认的交集会被签发；一次性确认不下放。
- batch、child 和嵌套 delegation 每层都必须显式列出 `confirmedTools`；省略即空，后代不能扩权。最终生效的工具名写入 `delegate_requested` 归档事件。
- 停止 root run 会通过同一个 `AbortSignal` 级联取消模型请求。
- 被取消节点记录为 `cancelled`；当前 run 即使 signal 已中断，仍允许写最终审计事件和 tree snapshot，但已被新 run 顶掉的旧 run 仍禁止写入。

后续可继续扩展更多只读 profile；危险权限继续保持独立的范围化 capability：

- `explore`：`rg_search`、`read_file`。
- `review`：`rg_search`、`read_file`、`git_diff_review`。
- `coder`：如新增语义 profile，写类工具仍必须走逐次 capability，不由 profile 隐式获得。

## 当前已实现

- `delegate_agent` internal tool 注册进 lazy tool registry。
- root `modelRun` 创建并注入 `DelegateAgentRuntime`。
- 树 path 分配：`root-01-01`。
- 并行 skill 蒸馏：core skill + 每 child brief。
- 长期 archive：conversation、run、event log、tree、nodes、results、run-local skills、global skills。
- `skillId`、`contentHash`、继承 skill ids、source 元数据。
- `runs/skills/agents` JSONL 索引。
- workspace 全局历史 run 浏览；不依赖当前对话中的 `delegate_agent` 消息即可加载完整树与 result/event 预览。
- 全局历史通过专用 runs 索引命令从文件尾向前分页，首屏优先最新 append 记录，跨页按 `conversationId+runId` 保留最新状态；cursor 绑定完整文件 fingerprint，append、自动压缩或原子替换后旧 cursor 会 fail-closed，刷新后从新快照重读。即使去重后的唯一记录超过通用文件读取 200 KiB 上限，也不会读取截断前缀冒充完整历史。
- 三类索引达到 128 KiB 后自动按逻辑 key 压缩；runtime、手动压缩与 skill 治理共用跨进程目标锁。
- candidate skill 的只读列举、显式 promote/archive、状态校验与独立审计日志。
- candidate skill 的确定性可解释评分与人工确认 UI；确认仅准备审计 CLI，不声称状态已变更。
- skill 治理使用预写 transaction journal，多文件提交中断后可幂等前滚或回滚。
- 子 agent headless loop。
- 子 agent 可递归调用 `delegate_agent`。
- child tool manifest 白名单过滤。
- 输入归一化、path 和 archive helper 单测。

## 生产级复盘（长期留存）

所有一次 `delegate_agent` 派发都落地到以下目录（以会话 + run 分区，天然防止跨 run 冲突）：

```text
.agent-archive/conversations/<conversationId>/runs/<runId>/
```

- `events.jsonl`：append-only 的事件流，用于完整回放。
- `tree.json`：最后一次树快照。
- `nodes/*.json`：每个节点独立快照。
- `results/*.result.md`：子 agent 结果输出。
- `skills/*.md`：run-local skill（用于可读性）。
- `.agent-archive/skills/<skillId>.md`：全局 skill（长期复用/检索）。
- `index/*.jsonl`：轻量索引（agents / skills / runs）。

### 一键复盘 CLI

新增脚本（`scripts/subagent-replay-report.js`）用于把上面的归档回放成可读报告或 JSON：

```bash
node scripts/subagent-replay-report.js --conversation <conversationId> --run <runId>
node scripts/subagent-replay-report.js --events .agent-archive/conversations/<conversationId>/runs/<runId>/events.jsonl --json
node scripts/subagent-replay-report.js --conversation <conversationId> --run <runId> --format text
```

输出字段含义：

- `事件统计`：按事件类型计数。
- `节点汇总`：总数、running/distilling/queued/done/failed/cancelled。
- `节点树状态`：每个 `path` 的状态、dispatch 次数、本地 skills、parent skills、result 文件。
- `子任务结果`：完成/失败节点和简要 summary。
- `解析异常`：JSON 行或类型异常会保留 `line` 与 `error`，不会阻塞报告生成。

推荐将该脚本命令接到 CI/本地工具中，作为长期复盘入口。

### 容量阈值治理 CLI

先查看容量与清理候选；这一步不会写入 archive：

```bash
pnpm subagent:archive:retention -- --max-bytes 524288000
```

当计划确认可达阈值后，把可再生成内容导出到 archive 外的目录并清理 live 派生文件：

```bash
pnpm subagent:archive:retention -- --prune --max-bytes 524288000 \
  --export ../subagent-retention-2026-08-03 --write
```

该操作只接受 `status: "delegated"` 的完成 run；若仅靠派生文件无法达到阈值，命令会拒绝操作，而不是删除
`events.jsonl` 或 `run.json`。导出清单中包含每个文件的 SHA-256，恢复会重新校验并且不覆盖 live 的任何文件：

```bash
pnpm subagent:archive:retention -- --restore ../subagent-retention-2026-08-03 --write
```

## 关键决策

### Path 与 ID 的边界

- `agentPath` 使用树路径字符串，便于人工排查和文件命名：`root-01-02`。
- `runId` 是当前一次 `delegate_agent` 运行的树身份（通常对应一次调用链 run），用于归档目录定位。
- 长期唯一性由 `skillId` 和 `runId` 承担，`root-01` 这类 path 仅在同一 run 内有效；因此不会跨 run 冲突。
- 文件名建议以 path 为主（例如 `root-01-task_brief.md`），因为路径天然表达层级和责任域；持久化索引和跨会话引用统一走 `skillId`。

### `delegate_agent` 策略语义

- `parallel_wait_all`（默认）
  - 子任务 brief 并发生成时全部成功才可继续。
  - 任一 brief 失败会中断该批次派发，返回错误。
  - 运行期每个 child 仍保留独立状态；只要出现 failed child，batch `status = failed`。
- `parallel_best_effort`
  - 每个 brief 有独立失败处理。
  - 子 task brief 生成失败时，仍保底生成“降级 brief”（占位任务描述），并返回子树结果。
  - 运行期 siblings 独立收尾：成功、失败与错误逐节点归档，不因局部失败丢弃成功结果。
  - 成功与失败混合时 batch `status = partial`；全部失败仍为 `failed`；发生取消为 `cancelled`。
- batch `summary` 明确统计 `total/done/failed/cancelled`。为兼容既有树/UI status，`partial` 的 root node 仍记为 `done`，失败 child 与 `error` 保持可见。

### 复盘与回放

新增了 `replay.ts`，用于从 `events.jsonl` + `tree.json` 重建执行快照：

- 事件流解析与容错：非 JSON 或结构异常记录为 `parseErrors`，不会阻塞解析。
- 节点重建：基于历史 event 和可选 tree snapshot 恢复 `nodes`、父子关系、技能产出和状态。
- 汇总：`summary` 提供 `running/distilling/queued/done/failed/cancelled`，`childResults` 直接给出已结束的节点产出。

入口与导出位于：
- [replay.ts](../packages/agent-core/src/subagents/replay.ts)
- `parseSubagentEvents`
- `parseSubagentTreeSnapshot`
- `replaySubagentArchive`

### 长期复盘目录落点（可检索）

```text
.agent-archive/
  conversations/
    <conversationId>/runs/<runId>/events.jsonl
  skills/
    <skillId>.md
  index/
    skills.jsonl
    agents.jsonl
```

运行结束后推荐保留至少三类资产：

1. `events.jsonl`：按时间还原过程与决策。
2. `tree.json`：某个 run 的最终快照。
3. `skills/<root|child>.xx-*.md` 与 `.agent-archive/skills/<skillId>.md`：内容来源与长期继承关系。

## 对后续任务建议（可选）

- 把 `replaySubagentArchive` 接到一个 CLI/UI 命令：
  - 输入 conversationId + runId；
  - 读取 `events.jsonl` 与 `tree.json`；
  - 输出统一树报告（节点状态、执行链、耗时、失败理由）。
- 逐步把 `parallel_best_effort` 的 fallback brief 标注到父节点摘要里，形成后续重试提醒。
- 在 `delegate_agent` 结果里把 `childResults` 与 `eventLog` 强绑定（便于 UI 直接渲染）。

- 将 child transcript 压缩结果可选回写到父节点 skill。
