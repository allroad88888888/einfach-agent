# Core 中断恢复 Issue 树

状态：**已收口：W8 完成（R0–R10、V1–V3 均已完成）**。本文件是这项迁移的唯一执行账本；每张卡完成后由主会话更新状态和证据，执行 agent 不并发修改本文件。

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
- 当前 checkpoint 仅保存 undo/history 所需的 `items`、`plan`、`context` 与阶段回退点；`run`、排队消息
  和所有其他运行态只存在于同代的 RecoverySnapshot V1。hydrate 只会归类 V1 中的 `running` /
  `awaiting_tool` 为 `interrupted`，并保留 V1 中自包含的等待状态。
- 旧版 session 动态镜像与 checkpoint 分两次写入；断电可读到不同代的对话与任务图。
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
7. SessionMeta 只保存静态元数据。hydrate 只接受已校验的 RecoverySnapshot V1；缺失、损坏或不可读 V1
   的会话只能保留静态登记，不能恢复或调度运行态。
   - **原文前半已随实现失效（2026-08-17）**：本条曾写「checkpoint 只保留用户 undo/history」，
     而轮级 checkpoint 已随用户 undo 迁往 einfach 事务日志（`createHistory`）而整体删除。
     现在 hydrate 没有第二种记录可退，本条的 fail-closed 因此**比立条时更强**。
8. 新增/大改普通文件不超过 300 行；单一强内聚恢复状态机可放宽至 500 行，卡中须说明理由并执行 `wc -l`。
9. 不使用 `git stash`、不碰本卡外文件、不 broad-stage；每卡只暂存其明确列出的路径。
10. **唯一副本必须进 allowlist。** 判据不是「这个 atom 看起来像不像运行态」，而是：**这份内容除了它自己
    还活在哪里？** 只要一段用户或模型产生的内容在 transcript、checkpoint、settings、磁盘里都没有第二份，
    它就不是 transient，不许以「UI 态」「临时卡片」为由排除在 V1 之外。
    - 反例一：`pendingArtifacts` 曾被当作 UI 卡片，而 `save_file` 只把 artifactId 和字节数回给模型，
      `content` 从不进 transcript——重启即永久丢失，模型却以为暂存成功（R12）。
    - 反例二（**已退场，2026-08-18**）：`composerDraft` 当年按「回退/撤回会把用户原话从 items 截断
      再放回输入框，那一刻它成为唯一副本」进表（R13）。原则本身仍然成立 ——
      **同一个 atom 的性质会随命令改变，按最坏那条路径判定**；但这个实例已经不成立：
      `rollbackPlanStage` 现在只截断 items 并立一条提示，**从不回写草稿**，那条最坏路径在实现里
      不存在了。草稿已随 UI store 拆分离开会话状态（刷新即丢，明确裁决）。
      教训是对称的：**理由所依赖的机制被删掉时，靠它进表的那一项也得跟着复核**，否则表里会长期
      挂着一条谁也验证不了的论证。
    - 有意排除必须给出「凭什么能重建」的具体机制并写进注释，二选一：可从别处**算回来**
      （如 `contextStats` 下次调用重算、`currentTurnIndex` = checkpoints 的 max turnIndex），
      或有**明确的补偿设计**（如 `browser-action` 直接要求模型把卡片内容写进最终回复）。
      「刷新即恢复安全默认」也是正当理由（如 `alwaysAllowedTools` 的危险工具授权不跨重启）。
      说不出机制 = 缺口，不是设计。
    - 新增任何写入 session store 的 atom 时，必须在本红线的三类归宿里选一类并说明；
      新增会产出内容的工具时，必须说明该内容在 transcript 里有没有副本。
    - **退场条件已兑现（2026-08-18）**，本红线保留为判据说明与历史记录，不再是需要人肉守的规矩：
      - `pnpm check:state` 的规则 4（`scripts/state-invariants/atomDisposition.js`）机械枚举
        `state/sessionAtoms.ts`、`state/sessionTransientAtoms.ts`、`state/subagentContinuationAtoms.ts`
        与 `execution/graph.ts` 里的每一个 atom，必须恰好落在
        slot / derived / recomputable / compensated / safeDefault / knownLoss 之一。未分类、陈旧条目、
        一 atom 两表、与 `SESSION_SLOTS` 双向不一致、登记为 derived 而源码是 primitive，全部当场 error。
      - 枚举面**自身**也不许悄悄过期：core 里任何含 atom 声明的文件，要么在枚举清单里、要么在
        `CORE_NON_SESSION_ATOM_FILES` 里写明凭什么不是会话状态。新开一个 `state/fooAtom.ts` 而不
        登记会直接 error —— 否则红线 10 这种静默缺席只是换个层级原样复发。
      - **「有没有漏登记」不再是判断；「归哪一类」仍然是判断**：门禁查得了登记自不自洽，查不了
        一条理由是真是假。R12（`pendingArtifacts`）与 R13（`composerDraft`）当年正是靠这层判断抓出来的
        —— 而 R13 后来被证明理由已随实现失效（见上面「反例二」），门禁同样查不出这一类过期。
    - **治理边界按「是不是会话状态」划。** 拆出 UI store 之前这条容易搞反：`ActiveSessionProvider`
      把整棵右栏挂在会话 store 上，渲染层随手 `useAtom` 的折叠态、消息窗口、图片附件物理上**都**
      落在会话 store 里，而那从不构成把它们纳入恢复契约的理由 —— 判据一直是「这份内容除了它自己
      还活在哪里」。
    - **2026-08-18 起两者重合**：界面自己持有**一个** store（`apps/web/src/uiStore.ts`），core 保留
      root store 与 per-session agent store，"是不是会话状态"由它住哪个 store 回答。规则 4 的
      `safeDefault` 因此从 7 条掉到 3 条 —— 掉的四条全是展开/折叠偏好，理由清一色「不含任何内容」，
      那不是归宿，是它们本就不该在 core 里。新增的**规则 5** 挡住这次拆分带来的新静默失败：
      core 之外用裸 `useAtomValue` 读 core 的 atom，读的是界面 store，拿到默认值且不报错。

## 目标分层

```text
业务 atom ── capture allowlist ──> RecoverySnapshot { static session, generation, values（含 continuation metadata） }
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
         └─ R9a 宿主恢复 driver 组装
```

波次：W0=`R0`；W1=`R1`；W2=`R2/R3`；W3=`R4/R5`；W4=`R6/R7/R8`；W5=`R9/R9a`；
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
- **目标**：定义 JSON-safe `RecoverySnapshotV1`、sessionId、generation、commit marker、静态 session
  入口元数据与 codec 升级入口；静态元数据明确排除动态 `plan`/`executionGraph`，其余值覆盖
  conversation、context、plan、plan stages、run、queue、问题答案、execution graph 及子 agent continuation
  metadata。
- **非目标**：不捕获 Store/atom identity，不决定存储表，不接线读取或写入。
- **验收**：schema round-trip、未知未来版本 fail-closed、旧空记录可识别；字段审计证明没有 derived/UI
  值；聚焦 vitest、core build、`wc -l` 和 `git diff --check` 均绿。
- **证据**：独立复核通过；静态元数据要求 session identity 匹配并拒绝动态 plan/graph，聚焦契约与投影
  用例 32/32，`pnpm --filter @einfach-agent/core build` 通过；type/codec/projection 分别 105/264/132 行，
  `git diff --check` 通过。

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

- **波次 / 依赖 / 状态**：W3 / R2、R3 / DONE
- **owner / 模型**：已验收 / strong（并发持久化）
- **独占面**：新建 `src/runtime/recoveryWriter.ts` 与测试；只为接线新增最小 recovery facade，不改
  hydrate 或具体 continuation。
- **目标**：每 session 串行 capture→commit，generation 单调且最后一次成功写不能被过时任务覆盖；提供明确的
  `persistRecovery` 边界 API 与 `flushRecovery` 关闭 API。capture 必须在一个 atom 批次/一致 epoch 内完成
  JSON-safe clone，异步排队后不得再读取活 atom；R6/R7/R8 各自负责在用户提交、item 固化、工具派发、等待态、
  计划阶段、队列和子任务调度的实际边界调用它。
- **非目标**：不每个 streaming token 强制同步写，不自行解释如何 resume，不安装泛化 atom subscription。
- **验收**：乱序 Promise、连续写入、失败后继续、删除 fence、dispose 前 `flushRecovery` 均有测试；driver
  failure 必须通过 outcome 与 observability diagnostic 暴露。
- **证据**：独立复核通过；writer/bridge 4 个 Vitest 文件 30/30，联合恢复测试 63/63，core build 通过。
  `recoveryWriter.ts` 229 行、bridge 237 行；`flushRecovery()` 只等待调用瞬间已入队的写入，未配置时是已解决
  Promise，删除以 durable tombstone 防迟到写复活。

### R5 · hydrate 与 interruption 分类

- **波次 / 依赖 / 状态**：W3 / R2、R3 / DONE
- **owner / 模型**：已验收 / strong（恢复入口）
- **独占面**：`state/persistence/hydrate.ts`、其测试和新的恢复分类模块；不得改 model loop、tool
  executor 或 checkpoint undo writer。
- **目标**：优先读取单代 snapshot，在一次 batch apply 后将真正 live 的运行状态转为 `interrupted`；
  `waiting_user`、`waiting_confirmation`、`waiting_plan_approval` 原样保留，graph 与 run 同代恢复。
  有效 v1 record 只能由这一份 record hydrate；缺失、损坏或不可读的 v1 都是 recovery failure，严禁退回
  checkpoint 或 SessionMeta 的历史动态字段。
- **非目标**：不自动执行模型/工具，不以 SessionMeta 的旧 graph 覆盖新 snapshot。
- **验收**：冷启动、有效 v1、缺失/损坏 v1、各 run status 和已填写答案都有恢复测试。
- **证据**：有效 v1 才能投影动态 atom；缺失或损坏 v1 只留下静态 session meta 和 checkpoint history；sessions
  列表读取失败仍可由 v1 重建。

### R6 · 模型循环与等待输入恢复

- **波次 / 依赖 / 状态**：W4 / R4、R5 / DONE
- **owner / 模型**：已验收 / strong（runtime integration）
- **独占面**：`modelRunLifecycle.ts`、`cardCommands.ts` 和其 focused tests；不改 tool executor、plan/subagent runtime、persistence driver 或 run/tool-loop command。工具未知态的继续策略由 R7 提供专职 helper，本卡只在 model lifecycle 接入它。
- **目标**：模型中断以最新 transcript 发起新请求；问题/审批卡和未提交答案原样显示并能消费，恢复后的
  每次状态迁移交给 writer 提交。
- **非目标**：不声称续接旧 HTTP stream，不清空 pending payload 来伪造 running。
- **验收**：模型请求前/流中/问题已填未交/审批等待四个重启点均可继续，且不会重复已固化 item。
- **证据**：`9f6ceff`；模型入口在 durability outcome 为 `saved|undefined` 后才进入 loop，恢复只从已固化 transcript 发起新请求；工具恢复 helper 未就绪或持久化失败时不启动 LLM。问题答案在提交后经同一实例的 recovery bridge 固化，独立 focused 验收通过。

### R7 · 工具 outcome 与确认恢复

- **波次 / 依赖 / 状态**：W4 / R4、R5 / DONE
- **owner / 模型**：已验收 / strong（副作用边界）
- **独占面**：tool loop interruption、tool confirmation command、其测试，以及只为 `RunState` 唯一 tool outcome 事实而做的 core type/codec 窄扩展；不改 plan/subagent continuation 或 driver。跨到 model lifecycle 的恢复策略只能经专职 helper 由 R6 接入。
- **目标**：为每个在飞 tool call 持久化 `notStarted | outcomeKnown | outcomeUnknown` 与恢复 policy；
  未知副作用停在可对账/确认状态，危险工具确认卡不丢失。
- **非目标**：不自动重复外部调用，不把 unknown 伪造成失败/成功，也不实现外部幂等服务。
- **验收**：派发前、执行中、结果落盘前、确认等待四个崩溃点均有测试；每种 policy 都有明确用户动作。
- **证据**：`2bae275`、`9520767`；`RunState` 的 per-call outcome 是唯一事实，恢复和普通工具边界都在 `saved|undefined` durability fence 后才产生下一副作用；unknown 停在对账路径，已知 receipt 不重复执行，completed text checkpoint 会保留到下一模型回合。独立 focused 验收通过。

### R8 · 计划和 subagent 可续接描述

- **波次 / 依赖 / 状态**：W4 / R4、R5 / DONE
- **owner / 模型**：已验收 / strong（任务编排）
- **独占面**：planning stage runtime、subagent runtime、execution graph 类型/测试；不改 model/tool
  loop 与 persistence driver。
- **目标**：将 graph 从展示状态扩成可验证的 continuation descriptor：计划阶段、root task、child objective、输入快照、调度状态和 outcome policy 都能随同一 generation 恢复并重新调度；graph status 本身不是 child 的可调度事实，descriptor 必须带 parent path、task spec、已知工具 outcome 与嵌套任务状态。
  只读写 R2 的 `subagentContinuationsAtom`，不得新增平行 child 状态源。
- **非目标**：不序列化子 agent 的 Promise/上下文窗口，不保证重复执行非幂等子任务。
- **验收**：根任务、暂停计划、排队 child、运行 child 重启后都有确定归宿：可继续、等输入或待对账，
  不遗失也不静默重跑。
- **证据**：`53f9a32` 完成 strict continuation descriptor、唯一的 `subagentContinuationsAtom` 事实和进程内 token/durability fence，恢复记录不会直接进入 child runner，terminal descriptor 保留；`1371fde` 完成计划 mutator 的实例级 `saved|undefined` 围栏与 Promise 调用方迁移，拒绝持久化时不推进工具响应、审批或回滚。两部分均经独立验收。

### R9 · 公共恢复命令与新旧会话切换

- **波次 / 依赖 / 状态**：W5 / R6、R7、R8、R9a / DONE
- **owner / 模型**：已验收 / strong（核心集成）
- **独占面**：run lifecycle command、core public facade、migration tests；只读调用已有恢复模块，
  不改 checkpoint undo command 或 persistence schema。
- **目标**：提供可发现的 session 恢复/继续入口；只有完整 recovery record 能提供可继续的运行态；没有有效
  V1 的会话保持不可恢复，不从 checkpoint 或 SessionMeta 推导运行态。
- **非目标**：不新增 redo/timeline UI，不删除旧数据，不自动跳过 unknown outcome。
- **验收**：混合新旧会话、多个 interrupted session、用户拒绝工具重试、继续子任务都有黑盒覆盖。
- **证据**：`8fb6f43`；Core facade 与根出口提供按显式 session id 发现状态和定向继续，不改变 active
  selection。命令在 bootstrap、timed hook 或模型请求前以 normal/timed outcome classifier 保守拒绝任何
  不可证明安全的状态；仅可证明尚未执行的普通 tool call 才可进入既有恢复边界。独立复核与 focused
  suites 通过（45/45），core build、根 `tsc --noEmit` 与 `git diff --check` 均通过。

### R9a · 宿主恢复 driver 组装

- **波次 / 依赖 / 状态**：W5 / R4、R5 / DONE
- **owner / 模型**：已验收 / strong（host integration）
- **独占面**：web/桌面宿主启动组装与其 focused tests；只配置已有 recovery driver、session store locator 与关闭前 flush，不改 core recovery 语义或 driver schema。
- **目标**：在真实宿主把 IDB/SQLite recovery driver 与 `configurePersistence` 接上，使 R6/R7/R8 的
  `persistRecovery` 不再是未配置 no-op；关闭/重载前等待已排队的 `flushRecovery()`。
- **非目标**：不改 checkpoint undo，不添加恢复 UI，不在宿主维护第二份业务状态。
- **验收**：生产启动路径配置 recovery、session store locator 与 flush；冷启动 smoke 证明写入的 v1
  snapshot 能被下一 Core 读回。
- **证据**：`ec9cca2`；web/桌面启动以本实例 Core 配置 IDB/SQLite recovery driver 与 session-store locator，启动先 hydrate，browser pagehide 与 desktop close 都走 recovery flush lifecycle。宿主 focused 验收通过。

### R10 · 移除双事实恢复路径

- **波次 / 依赖 / 状态**：W7 / R9、V1、V2 / DONE
- **owner / 模型**：已验收 / strong（收口迁移）
- **独占面**：checkpoint recovery payload、SessionMeta execution graph 双写、旧 hydrate branch 和测试；
  由单一 owner 串行完成。
- **目标**：移除运行恢复对历史双写的依赖；checkpoint 保留为用户 undo/history，完整 RecoverySnapshot V1
  成为唯一运行恢复投影。
- **非目标**：不删除用户 checkpoint 数据或修改其显式回退语义；不为旧格式动态状态提供兼容恢复或迁移。
- **验收 / 证据**：生产源不存在历史 checkpoint recovery 或 SessionMeta 动态镜像的类型、读写或 hydrate 分支；有效 V1 仍恢复 live atoms，缺失/损坏 V1 只保留静态 session 与 sanitized checkpoint history。Core 源码全量 191 files/1637 tests、SQLite 4 files/21 tests、`pnpm build`、`pnpm check:boundaries`、`pnpm check:dist` 与 `git diff --check` 均通过。

### V1 · 崩溃点全链路验证

- **波次 / 依赖 / 状态**：W6 / R9 / DONE
- **owner / 模型**：已验收 / independent-audit
- **独占面**：只新增独立 integration tests；不改生产实现或既有单元测试。
- **目标**：以进程重建模拟每一 durable boundary 的中断，核验 allowlist atom、resume kind 和无重复副作用。
- **验收 / 证据**：对话、排队消息、问题已填答案、工具四阶段、计划、root/child task 均有正反例与 generation 一致性断言；R10 收口后的 Core 源码全量验证通过。

### V2 · SQLite / IDB 原子性与产物验证

- **波次 / 依赖 / 状态**：W6 / R9 / DONE
- **owner / 模型**：已验收 / independent-audit
- **独占面**：只新增/调整黑盒验证和打包脚本；不改 recovery 生产模块。
- **目标**：验证两个 driver 的提交可见性、落后写保护、跨版本读取和已发布 core 的恢复出口。
- **验收 / 证据**：SQLite/IDB crash fixture、`pnpm build`、`pnpm check:boundaries`、`pnpm check:dist` 通过；SQLite 源码 suite 4 files/21 tests 通过。

### V3 · 独立架构审计与交付

- **波次 / 依赖 / 状态**：W8 / R10、V1、V2 / DONE
- **owner / 模型**：已验收 / independent-audit
- **独占面**：只读审计，允许更新本文件状态；不改实现。
- **目标**：逐条检查红线、allowlist 完整性、单一事实、外部副作用策略和文件职责，而不只看测试。
- **验收 / 证据**：无 redo/history cursor/atom identity 持久化；无恢复双写；新增/大改文件符合行数约束；独立审计与所有交付门禁通过。

### R11 · 修复 R7 引入的 coreInstance 初始化环

- **波次 / 依赖 / 状态**：W9 / R7 / DONE
- **owner / 模型**：主会话 / strong（模块边界）
- **独占面**：新建 `src/runtime/timedToolRegistry.ts`；`timedDispatch.ts` 转出注册簿，`coreInstance.ts`
  改引叶子模块。不改定时派发语义、恢复围栏或 `rootStore` 的顶层求值形态。
- **背景**：R7（`2bae275`）给 `timedDispatch.ts` 加了 `sessionAtoms` / `sessionWriters` /
  `toolCallExecutionFence` 三条静态导入，闭合了
  `coreInstance → timedDispatch → state/sessionWriters → state/rootStore → coreInstance`。
  `rootStore.ts` 在模块顶层求值 `defaultCore.rootStore`，环内它读到 `undefined` 并抛
  `TypeError`。该文件原本以动态 import（`loadTimedDispatchDependencies`）避开这条环，R7 的静态
  导入破了这个纪律。
- **影响**：`apps/web` 两个用 `vi.resetModules()` 的宿主装配测试自 `2bae275` 起持续失败（5 个用例），
  且 R7–V3 每张卡的证据都只跑了聚焦 suite 与 `pnpm build`，从未执行统一门禁要求的全量 `pnpm test`，
  因此那段时间的“门禁通过”结论对本条不成立。
- **目标**：把 `createTimedToolRegistry` 抽成只依赖 `tools/*` 类型的叶子模块，`coreInstance` 对
  `timedDispatch` 只保留 `import type`（编译期擦除，不产生运行时边）。
- **验收 / 证据**：修复前全量 `pnpm test` 为 2 files / 5 tests 失败，修复后 423 files（3 skipped）/
  3300 tests 全绿；`pnpm build`、`pnpm check:boundaries`（569 文件）、`pnpm check:dist`、
  `node scripts/check-docs.js` 与 `git diff --check` 均通过。`timedDispatch.ts` 267 → 190 行，
  新模块 91 行。定位方式为在 `8d70fcc`→`fd9dac4` 之间逐点重跑那两个测试文件。

### R12 · 待保存产物入 allowlist

- **波次 / 依赖 / 状态**：W9 / R2、R10 / DONE
- **owner / 模型**：主会话 / strong（数据契约）
- **独占面**：`recoverySnapshot.type.ts`、`recoverySnapshot.codec.ts`、`recoveryProjection.ts` 与恢复
  fixture；不改工具实现、命令或 driver schema。
- **背景**：`save_file` 回给模型的结果只有 `{accepted, artifactId, bytes}`，`content` 从不进 transcript，
  `pendingArtifactsAtom` 是它唯一的副本。它此前被当作 UI 卡片排除在 V1 之外，重启即永久丢失，
  而模型认为暂存成功。
- **目标**：`pendingArtifacts` 进 V1 allowlist，codec 校验 id 唯一、`content` 为字符串、不含未知字段。
- **非目标**：不改 `save_file` 的 5 MB 上限，不为产物另建表——快照本来就带完整 `items`，产物不改变量级。
- **验收 / 证据**：`23f24bd`；产物内容跨 apply 往返，缺失字段/重复 id/非字符串 content/未知字段四类
  codec 用例 fail-closed。投影测试按值语义与边界拆成两个文件加一份共享 fixture，均在 300 行内。
  注意 `*.fixtures.ts` **不在** `check:boundaries` 的测试豁免里，按生产源扫描——本卡的 fixture 因此
  改用中性厂商名（codec 只要求 `vendor` 是字符串），不能照抄测试里的真实厂商名。

### R13 · 撤回的用户原话不随重启丢失

> **已退场（2026-08-18）**：本卡的前提是「两个撤回路径把用户原话放回输入框」。那两处
> `setComposerDraft` 后来随 checkpoint 命令改造消失了，而本卡的成果（`composerDraft` 进 allowlist）
> 没人回来复核，于是槽位表里长期挂着一条实现已不支持的理由。现在 `composerDraft` 已随 UI store
> 拆分整个离开会话状态：草稿刷新即丢是明确裁决，`SESSION_SLOTS` 与 `RecoveryAtomProjectionV1`
> 都不再有它。下面保留原文作为记录。

- **波次 / 依赖 / 状态**：W9 / R12 / DONE（前提已失效，见上）
- **owner / 模型**：主会话 / strong（用户内容边界）
- **独占面**：同 R12 三个文件，外加 `recoveryProcess.integration.test.ts`；不改 checkpoint 命令本身。
- **背景**：`checkpointCommands.ts:93` 与 `:135` 在回退/撤回时把用户原话从 `items` 截断后放回输入框，
  同一条命令随即提交 `persistRecovery`。落盘的那一代带的是已截断的 items，而 `composerDraft` 不在
  allowlist——重启后两处都没有，是纯粹的用户数据丢失。
- **目标**：`composerDraft` 进 allowlist。两个撤回路径的 `setComposerDraft` 本就排在 `persistRecovery`
  之前，命令代码无需改动即被覆盖。
- **非目标**：不恢复撤回轮的图片等附件——放回输入框的历来只有 `userMessageText` 的纯文本。
- **验收 / 证据**：跨 Core 集成用例证明撤回后新进程仍能拿回原话；摘掉 capture 一行该用例即红，
  确认它咬住实现而非空转。

## 收口后的已知语义与遗留

1. **无有效 V1 的会话开屏是空对话。** 这是红线 7 的有意 fail-closed，不是缺陷：hydrate 只投影 V1，
   checkpoint 只留 undo/history。波及面限于 V1 落地前建的会话与 V1 损坏的会话；`apps/cli` 只配内存
   history、不走 hydrate，不受影响。已裁决直接丢弃这类存量数据，不做兼容回填。
   连带后果：`currentTurnIndexAtom` 停在最后一轮而 `itemsAtom` 为空，下一次 `commitCheckpoint` 会在
   turnIndex+1 落一条只含新内容的 checkpoint，该会话的 checkpoint 序列出现 items 断层。同样按丢弃处理。
   将来若要回填，唯一安全的来源是最后一个 `kind === 'completed'` 的 checkpoint：`working` / `stopped`
   的 items 可能含未配对 tool_use，载入后下一轮模型请求会被供应商直接拒绝。

2. **SQLite 老库仍保留已废弃的 `checkpoints.recovery` 列。** R10 移除了它的建表、读、写与 ALTER 迁移，
   但不 drop 存量列。它不再被任何代码读写，留着无害；不提供清理迁移。

## 统一交付门禁

每张生产卡至少给出聚焦 `vitest`、`pnpm --filter @einfach-agent/core build`、新增/大改文件的 `wc -l`
输出和 `git diff --check`。切换后必须额外通过：

```sh
pnpm test
pnpm build
pnpm check:boundaries
pnpm check:dist
```

发现新的持久业务 atom、未定义 outcome policy 的外部 effect，或绕过 R4 的直接写入时，必须停止扩张
改动面，把事实追加到本树并由主会话拆出独占补卡后再继续。

`pnpm test` 是**全仓库**跑，不接受用 `vitest run <目录>` 的聚焦子集顶替：R11 那条环只在
`apps/web` 的装配测试里暴露，core 与 persistence 的聚焦 suite 全绿也照样漏掉它。给"切换后门禁
通过"的结论前，必须贴全量 `pnpm test` 的 Test Files / Tests 行。

把门禁串成 `cmd | tail` 或 `cmd | grep` 时，管道的退出码是**最后一段**的，前面的失败会被吞掉，
`&&` 照样往下走——R12/R13 那轮就这样在 `边界检查失败` 之后仍打印了 ALL_GATES_OK。串门禁必须
`set -o pipefail`，或者分开跑各自看退出码；只凭末尾那行 OK 判定通过是无效证据。
