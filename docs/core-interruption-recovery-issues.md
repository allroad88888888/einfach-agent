# Core 中断恢复 Issue 树

状态：**规划已冻结，W2 已完成，W3 进行中**。本文件是这项迁移的唯一执行账本；每张卡完成后由主会话
更新状态和证据，执行 agent 不并发修改本文件。

本文件替代提交 `8d70fcc` 中误设为「可逆历史 / redo」的树。那条方向不再执行。

## 目标与裁决

目标不是 redo，也不是另造一套业务状态：任务被关闭、崩溃或中断后，下一次启动从最近一次**完整的
持久化 atom 投影**恢复，同一任务可按其断点继续。

“1:1 恢复”定义为：恢复完成后，白名单内的持久业务 atom 的值与最近一次成功提交的 generation
逐值等价；derived atom 重新计算，不落盘。atom 实例、Promise、AbortController、网络流和外部进程
不能跨进程复活，不计入该保证。

对正在调用外部工具的任务，恢复的是调用描述、已知结果和 `outcomeUnknown` 断点；不得因重启自动
重复可能有副作用的调用。模型流则以已持久化 transcript 发起一次新的请求继续，而非假称接回旧连接。
等待用户回答、危险工具确认、计划审批等纯数据断点必须原样恢复。

已有的 checkpoint「回退 / undo」是显式用户编辑操作，保持原语义；它不承担任务恢复职责。本树不增加
redo、历史 cursor、追加日志或将 atom 身份持久化。

### 已确认事实

- `checkpointWriters.ts` 的跳转/回退会截断未来；这是用户 undo，不是恢复机制。
- 当前 working checkpoint 保存 `items`、`plan`、`context`、`run` 与排队消息；hydrate 会把
  `running` / `awaiting_tool` 变为 `interrupted`，等待输入/确认/审批则原样恢复。
- `SessionMeta.executionGraph` 与 checkpoint 分两次写入；断电可读到不同代的对话与任务图。
- `continueInterruptedModelRun` 会把未结 tool call 写成 unknown 后重新请求模型，不能表达每个任务的
  可恢复契约；`ExecutionGraphSnapshot` 也只有展示状态，缺少可重新调度的工作描述。
- `pendingQuestionAnswersAtom` 独立于 `RunState`，当前未落入 checkpoint；已填写但未提交的答案会丢。
- session 的 atom key 可稳定定位模块导出，但 Store/atom 实例是进程内对象；持久化必须保存逻辑字段和
  JSON-safe 值，hydrate 再写回同一组 atom。

### 红线

1. 业务 atom 是唯一事实来源；`RecoverySnapshot` 只是其序列化投影，绝不被读路径当作第二套状态。
2. 每份快照包含一个 revision/generation；对话、计划、run、队列、等待输入答案和 execution graph
   必须来自同一代，hydrate 只能采用完整提交的一代。
3. snapshot 字段使用稳定逻辑名和版本化 codec，绝不保存 atom object、Store、函数、Promise 或数组位置。
4. capture/apply 只能经显式 allowlist；derived/UI-only atom 不入快照，apply 在一个 Einfach 批次中完成。
5. 持久化写入按 session 串行且 generation 单调；旧的异步写绝不能覆盖较新的成功提交。
6. 恢复前在飞运行统一转成可解释的 interruption state；仅在 resume policy 明确安全时自动继续，外部副作用
   未知时必须停在可确认/可对账状态。
7. 切换期不再把 `Checkpoint.recovery` 与 `SessionMeta.executionGraph` 当成双事实来源；旧 checkpoint 仍可
   读取并保留用户 undo，旧会话必须降级可读，不能丢数据。
8. 新增/大改普通文件不超过 300 行；单一强内聚恢复状态机可放宽至 500 行，卡中须说明理由并执行 `wc -l`。
9. 不使用 `git stash`、不碰本卡外文件、不 broad-stage；每卡只暂存其明确列出的路径。

## 目标分层

```text
业务 atom ── capture allowlist ──> RecoverySnapshot { generation, values（含 continuation metadata） }
     ^                                      │
     │                              single-record durable commit
     └── atomic apply + derived recompute ──┘
                                            │
                    hydrate ── interruption classifier ── explicit resume command
```

建议文件职责（不是预先创建清单；按卡创建）：

| 路径 | 一句话职责 | 上限 |
| --- | --- | --- |
| `src/state/recoverySnapshot.type.ts` | 定义版本化的可持久化恢复数据 | 300 |
| `src/state/recoveryProjection.ts` | 在 atom allowlist 与快照之间 capture/apply | 300 |
| `src/state/persistence/recoveryDriver.ts` | 定义单代恢复记录的存取契约 | 300 |
| `src/runtime/recoveryWriter.ts` | 串行提交 session 恢复 generation | 300 |
| `src/runtime/recoveryContinuations.ts` | 将中断状态分类成安全的继续动作 | 300 |

## 树与波次

```text
R0 语义裁决与恢复状态盘点（DONE）
└─ R1 版本化 RecoverySnapshot 契约
   ├─ R2 atom 投影 allowlist 与原子 apply
   └─ R3 单记录持久化 driver
      ├─ R4 generation 写入序列器与落盘边界
      └─ R5 hydrate 与 interruption 分类
         ├─ R6 模型循环与等待输入恢复
         ├─ R7 工具 outcome / 确认恢复
         └─ R8 计划和 subagent 可续接描述
            └─ R9 公共恢复命令与新旧会话切换
               ├─ V1 崩溃点全链路验证
               ├─ V2 SQLite / IDB 原子性与产物验证
               └─ R10 移除双事实恢复路径
                  └─ V3 独立架构审计与交付
```

波次：W0=`R0`；W1=`R1`；W2=`R2/R3`；W3=`R4/R5`；W4=`R6/R7/R8`；W5=`R9`；
W6=`V1/V2`；W7=`R10`；W8=`V3`。同一现有文件只允许一个 active owner。

## 卡

### R0 · 语义裁决与恢复状态盘点

- **波次 / 依赖 / 状态**：W0 / — / DONE（本树修订时完成）
- **owner / 模型**：主会话 / architecture
- **改动面**：仅本文件。
- **目标**：固定上述定义、红线和当前缺口，明确 “atom 值恢复” 不等于网络/进程复活。
- **非目标**：不创建生产模块，不改 checkpoint undo。
- **证据**：本文件“已确认事实”、目标分层和逐卡独占面。

### R1 · 版本化 RecoverySnapshot 契约

- **波次 / 依赖 / 状态**：W1 / R0 / DONE
- **owner / 模型**：R1-contract / strong（数据契约）
- **独占面**：新建 `packages/agent-core/src/state/recoverySnapshot.type.ts`、`recoverySnapshot.codec.ts` 及
  colocated 测试；只允许最小 type barrel 出口，不改 runtime/persistence。
- **目标**：定义 JSON-safe `RecoverySnapshotV1`、sessionId、generation、commit marker、逻辑字段名与
  codec 升级入口；覆盖 conversation、context、plan、plan stages、run、queue、问题答案、execution graph
  及子 agent continuation metadata。
- **非目标**：不捕获 Store/atom identity，不决定存储表，不接线读取或写入。
- **验收**：schema round-trip、未知未来版本 fail-closed、旧空记录可识别；字段审计证明没有 derived/UI
  值；聚焦 vitest、core build、`wc -l` 和 `git diff --check` 均绿。
- **证据**：独立复核通过；`recoverySnapshot.type.test.ts` 17/17，`pnpm --filter @web-agent/core build`
  通过；type/codec/test 分别 85/240/178 行，`git diff --check` 通过。

### R2 · atom 投影 allowlist 与原子 apply

- **波次 / 依赖 / 状态**：W2 / R1 / DONE
- **owner / 模型**：已验收 / strong（Einfach 状态边界）
- **独占面**：新建 `src/state/recoveryProjection.ts`、`src/state/subagentContinuationAtoms.ts` 及测试；
  只读导入既有 session/transient atom，不改 hydrate、loop 或 driver。
- **目标**：显式 capture 每个可恢复 atom，使用 Einfach 的批次能力 apply 一份完整 snapshot；禁止
  复制可推导值，并在 apply 后重建/清空仅进程内辅助对象；新增的 session-scoped
  `subagentContinuationsAtom` 是 child 逻辑续接描述的唯一 atom 真源，R8 只能读写它而不能另建副本。
- **非目标**：不靠订阅隐式收集 atom，不保存 composer/UI 卡片，不写磁盘。
- **验收**：每个 allowlist 字段逐值往返；漏字段测试失败；apply 观察不到半个世界；多 session 隔离。
- **证据**：独立复核通过；`recoveryProjection.test.ts` 7/7、core build 与 `git diff --check` 通过；
  projection/continuation atom/test 分别 111/7/285 行。原值和 clone 都经 codec 验证，函数/环引用
  会在写入前 fail-closed。

### R3 · 单记录持久化 driver

- **波次 / 依赖 / 状态**：W2 / R1 / DONE
- **owner / 模型**：已验收 / strong（跨 driver schema）
- **独占面**：新建 core recovery persistence contract、IDB/SQLite 的 recovery record 实现、迁移与测试；
  不改现有 checkpoint hydrate/命令。
- **目标**：为每 session 原子存取一个完整 generation，并以条件写入拒绝陈旧 generation；读只接受带
  commit marker 的最高 generation，缺失记录按旧会话处理，损坏记录 fail-safe 且不删除用户 checkpoint；
  删除必须留下 generation fence/tombstone，令已在飞的旧写不能复活已删除会话。
  IDB 的比较与 put 必须在同一 `readwrite` transaction，SQLite 禁止伪 transaction，使用一条条件 UPSERT。
- **非目标**：不移除 checkpoint 表，不在此卡双写业务状态，不实现恢复 UI。
- **验收**：IDB/SQLite 均验证断写只读到上一完整代、版本迁移、空/损坏降级；两个持久化包 build 绿。
- **证据**：独立复核通过；恢复相关 7 个 Vitest 文件 50/50，core、IDB、SQLite build 均通过，
  `git diff --check` 通过。IDB 在 v2 的同库 `recoverySnapshots` store 内以单个 readwrite transaction
  比较并写入，SQLite 以单条条件 UPSERT 写入；两者均以 tombstone 阻止删除后的迟到写复活。

### R4 · generation 写入序列器与落盘边界

- **波次 / 依赖 / 状态**：W3 / R2、R3 / BLOCKED
- **owner / 模型**：待派 / strong（并发持久化）
- **独占面**：新建 `src/runtime/recoveryWriter.ts` 与测试；只为接线新增最小 recovery facade，不改
  hydrate 或具体 continuation。
- **目标**：每 session 串行 capture→commit，generation 单调且最后一次成功写不能被过时任务覆盖；定义
  事务边界：用户提交、assistant/tool item 固化、工具派发前后、等待态、计划阶段、队列和子任务调度。
  capture 必须在一个 atom 批次/一致 epoch 内完成 JSON-safe clone，异步排队后不得再读取活 atom。
- **非目标**：不每个 streaming token 强制同步写，不自行解释如何 resume。
- **验收**：乱序 Promise、连续写入、失败重试、dispose 时 flush 均有测试；每个已列边界都有调用证据。

### R5 · hydrate 与 interruption 分类

- **波次 / 依赖 / 状态**：W3 / R2、R3 / BLOCKED
- **owner / 模型**：待派 / strong（恢复入口）
- **独占面**：`state/persistence/hydrate.ts`、其测试和新的恢复分类模块；不得改 model loop、tool
  executor 或 checkpoint undo writer。
- **目标**：优先读取单代 snapshot，在一次 batch apply 后将真正 live 的运行状态转为 `interrupted`；
  `waiting_user`、`waiting_confirmation`、`waiting_plan_approval` 原样保留，graph 与 run 同代恢复。
  有效 v1 record 只能由这一份 record hydrate；已存在但损坏的 v1 是 recovery failure，严禁退回并拼接
  legacy checkpoint/session meta；只有完全缺失 v1 才允许 legacy fallback。
- **非目标**：不自动执行模型/工具，不以 SessionMeta 的旧 graph 覆盖新 snapshot。
- **验收**：冷启动、旧 checkpoint fallback、torn legacy pair、各 run status 和已填写答案都有恢复测试。

### R6 · 模型循环与等待输入恢复

- **波次 / 依赖 / 状态**：W4 / R4、R5 / BLOCKED
- **owner / 模型**：待派 / strong（runtime integration）
- **独占面**：model-run lifecycle、ask-user command、checkpoint flush 接线及测试；不改 tool executor、
  plan/subagent runtime 或 persistence driver。
- **目标**：模型中断以最新 transcript 发起新请求；问题/审批卡和未提交答案原样显示并能消费，恢复后的
  每次状态迁移交给 writer 提交。
- **非目标**：不声称续接旧 HTTP stream，不清空 pending payload 来伪造 running。
- **验收**：模型请求前/流中/问题已填未交/审批等待四个重启点均可继续，且不会重复已固化 item。

### R7 · 工具 outcome 与确认恢复

- **波次 / 依赖 / 状态**：W4 / R4、R5 / BLOCKED
- **owner / 模型**：待派 / strong（副作用边界）
- **独占面**：tool loop interruption、tool confirmation command、其测试；不改 model/plan/subagent
  continuation 或 driver。
- **目标**：为每个在飞 tool call 持久化 `notStarted | outcomeKnown | outcomeUnknown` 与恢复 policy；
  未知副作用停在可对账/确认状态，危险工具确认卡不丢失。
- **非目标**：不自动重复外部调用，不把 unknown 伪造成失败/成功，也不实现外部幂等服务。
- **验收**：派发前、执行中、结果落盘前、确认等待四个崩溃点均有测试；每种 policy 都有明确用户动作。

### R8 · 计划和 subagent 可续接描述

- **波次 / 依赖 / 状态**：W4 / R4、R5 / BLOCKED
- **owner / 模型**：待派 / strong（任务编排）
- **独占面**：planning stage runtime、subagent runtime、execution graph 类型/测试；不改 model/tool
  loop 与 persistence driver。
- **目标**：将 graph 从展示状态扩成可验证的 continuation descriptor：计划阶段、root task、child
  objective、输入快照、调度状态和 outcome policy 都能随同一 generation 恢复并重新调度；graph status
  本身不是 child 的可调度事实，descriptor 必须带 parent path、task spec、已知工具 outcome 与嵌套任务状态。
  只读写 R2 的 `subagentContinuationsAtom`，不得新增平行 child 状态源。
- **非目标**：不序列化子 agent 的 Promise/上下文窗口，不保证重复执行非幂等子任务。
- **验收**：根任务、暂停计划、排队 child、运行 child 重启后都有确定归宿：可继续、等输入或待对账，
  不遗失也不静默重跑。

### R9 · 公共恢复命令与新旧会话切换

- **波次 / 依赖 / 状态**：W5 / R6、R7、R8 / BLOCKED
- **owner / 模型**：待派 / strong（核心集成）
- **独占面**：run lifecycle command、core public facade、migration tests；只读调用已有恢复模块，
  不改 checkpoint undo command 或 persistence schema。
- **目标**：提供可发现的 session 恢复/继续入口；新会话以 recovery record 为准，旧会话用现有
  checkpoint 只读 hydrate 后在首个稳定边界生成新 snapshot。
- **非目标**：不新增 redo/timeline UI，不删除旧数据，不自动跳过 unknown outcome。
- **验收**：混合新旧会话、多个 interrupted session、用户拒绝工具重试、继续子任务都有黑盒覆盖。

### R10 · 移除双事实恢复路径

- **波次 / 依赖 / 状态**：W7 / R9、V1、V2 / BLOCKED
- **owner / 模型**：待派 / strong（收口迁移）
- **独占面**：checkpoint recovery payload、SessionMeta execution graph 双写、旧 hydrate branch 和测试；
  由单一 owner 串行完成。
- **目标**：移除运行恢复对两份异步记录的依赖；checkpoint 保留为用户 undo/history，recovery record
  成为唯一运行恢复投影。
- **非目标**：不删除用户 checkpoint 数据或修改其显式回退语义。
- **验收**：生产源中没有以 checkpoint recovery + SessionMeta graph 拼接恢复的路径；旧数据迁移后
  重启不丢 transcript/plan/run，所有原有 undo 测试保留。

### V1 · 崩溃点全链路验证

- **波次 / 依赖 / 状态**：W6 / R9 / BLOCKED
- **owner / 模型**：待派 / independent-audit
- **独占面**：只新增独立 integration tests；不改生产实现或既有单元测试。
- **目标**：以进程重建模拟每一 durable boundary 的中断，核验 allowlist atom、resume kind 和无重复副作用。
- **验收**：对话、排队消息、问题已填答案、工具四阶段、计划、root/child task 均有正反例与 generation
  一致性断言。

### V2 · SQLite / IDB 原子性与产物验证

- **波次 / 依赖 / 状态**：W6 / R9 / BLOCKED
- **owner / 模型**：待派 / independent-audit
- **独占面**：只新增/调整黑盒验证和打包脚本；不改 recovery 生产模块。
- **目标**：验证两个 driver 的提交可见性、落后写保护、跨版本读取和已发布 core 的恢复出口。
- **验收**：SQLite/IDB crash fixture、`pnpm build`、`pnpm check:boundaries`、`pnpm check:dist` 通过。

### V3 · 独立架构审计与交付

- **波次 / 依赖 / 状态**：W8 / R10、V1、V2 / BLOCKED
- **owner / 模型**：待派 / independent-audit
- **独占面**：只读审计，允许更新本文件状态；不改实现。
- **目标**：逐条检查红线、allowlist 完整性、单一事实、外部副作用策略和文件职责，而不只看测试。
- **验收**：无 redo/history cursor/atom identity 持久化；无恢复双写；新增/大改文件行数报告；完整命令、
  退出码和剩余风险留档。

## 统一交付门禁

每张生产卡至少给出聚焦 `vitest`、`pnpm --filter @web-agent/core build`、新增/大改文件的 `wc -l`
输出和 `git diff --check`。切换后必须额外通过：

```sh
pnpm test
pnpm build
pnpm check:boundaries
pnpm check:dist
```

发现新的持久业务 atom、未定义 outcome policy 的外部 effect，或绕过 R4 的直接写入时，必须停止扩张
改动面，把事实追加到本树并由主会话拆出独占补卡后再继续。
