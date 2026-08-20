# 线：子 Agent 委派与归档治理
一句话：主 run 用一个内部工具把一批 headless 子 run 交给独立于主循环的调度/执行内核，结果经执行图回投影、过程全量落盘到 `.webAgent-archive/`。
类型：分支线——挂在主线的 `packages/agent-core/src/runtime/toolLoopBootstrap.ts:85`（运行时，每个 run 造一个 `DelegationRuntime`）与 `apps/web/src/main.tsx:148` / `apps/cli/src/runtime.ts:134`（装配时，`configureDefaultDelegation`）。

## 入口（一个实例从哪开始；引 file:line）
- 装配：`apps/web/src/main.tsx:148`、`apps/cli/src/runtime.ts:134` 把 `createDelegationAssembly`（`packages/subagents/src/delegationAssembly.ts:6`）装进 core。一个装配 = 一颗**共享 scheduler** + 一个 `createRuntime` 工厂。
- 每 run：`packages/agent-core/src/runtime/toolLoopBootstrap.ts:85` 用会话设置/apiKey/signal 造 `DelegationRuntime`，并把 `onNodeChange` / `onTraceItem` 接到执行图。
- 每次工具调用：`packages/agent-core/src/runtime/toolContext.ts:144` → `runtime/toolContext/delegationCapabilities.ts:48` 在 `ToolContext` 上挂 `delegateAgents` / `spawnAgents` / `observeExecution` / `joinExecution` / `cancelExecution`。
- 模型侧：`tools/agents/src/delegate-agent/delegate-agent.ts:127`（`delegate_agent`，`runtime: 'internal'`、`replayUnsafe: true`）。

## 数据怎么走（逐步；每步引 file:line）
1. **声明**——四个工具在 `tools/agents/src/index.ts:13` 由 `registerAgentsTools` 注册：`delegate_agent`（派发）、`observe_agent`、`join_agent`、`cancel_agent`（后台句柄的读/等/取消）。
2. **归一化**——`delegate-agent.ts:138` 调 `normalizeDelegateAgentInput`（`packages/agent-core/src/subagents/input.ts`），默认与硬顶在 `input.ts:16-28`：children 6/12、concurrent 4/8、depth 2/6、turns 4/16、totalNodes 64/256、modelCalls 128/512。`delegate-agent.ts:102` 的 `inputPreservingOptionalPresence` **刻意不物化默认值**——"缺省=继承、显式=只能收紧"靠字段在不在来判。
3. **触发**——`delegate-agent.ts:164` 优先走 `ctx.spawnAgents`：`delegationCapabilities.ts:122` 把整批派发交给 `execution/runtime.ts:99` 的 `spawn`，立刻建一个 `type:'agent-batch'` 执行图节点并**立即返回句柄**；工具结果里是 `executionId`，不是子树结果。
4. **策略校验**——`subagents/delegationPolicy.ts:38` 一次性解出 parentPath / 预算 / toolProfile / confirmedTools：预算逐项 `Math.min` 收紧（:54-70）；profile 只能沿 `delegate_only ⊂ workspace_read ⊂ workspace_verify` 收窄（:77-89）；危险工具能力四项独立校验 sessionId/runId/delegationCallId/parentPath（:93-100）；深度与 children 上限在 :112-119。
5. **预留与登记**——`subagents/delegationBatch.ts:102` 先扣整树节点预算，:110 `scheduler.reserveChildren` 分配 `root-01` 式 path（`packages/subagents/src/schedulerState.ts:109`），:123-135 把每个 child 的预算/profile/confirmedTools 落进 `DelegationCallState` 的三张 Map。
6. **续跑落盘（栅栏一）**——`delegationBatch.ts:139` `persistQueuedChildContinuations` → `continuationStore.ts:41` 在一次事务里 append 全部 queued 条目并 patch 父条目的 `nestedChildIds`，然后 `continuationLifecycle.ts:31` **要求快照真的 saved** 才继续。
7. **蒸馏**——`delegationBatch.ts:159` 走注入的 `skillDistill` 端口（实现 `packages/subagents/src/archive/distill.ts`）：1 条父 core skill + N 条 child brief，:164 双写 run-local 与全局 skill 文件。失败路径在 `delegationBatch.ts:238-299`，`parallel_wait_all` 整批中止并把 reserved 全标 failed/cancelled。
8. **并发跑子 run**——`delegationBatch.ts:172` 用 `createConcurrencyLimiter(budget.maxConcurrent)` 逐个起；:177 `persistChildExecutionFence`（栅栏二）把该 child 置为 `outcome_unknown` 并再落一次快照，之后才允许它发第一次模型请求。
9. **子 run 循环**——`subagents/childAgentLoop.ts:72`，见下节"与主循环的差别"。
10. **结果回投影**——`childResult.ts:131` `finalizeChildResult`：写 `results/<path>.result.md`、`scheduler.markNode`、写 `child_finished` 事件、把 continuation 打成 terminal；`markNode` 经 `runtimeState.ts:162` 的订阅回调进 `execution/runtime.ts:257` `syncAgentNode`，转成执行图 `node.status`（`type:'agent'`，parentId = `<treeId>:<parentPath>`）。子 run 的每条模型消息经 `execution/runtime.ts:302` `appendAgentTrace` 进同一张图的 `node.trace`。
11. **批次收尾**——`delegationBatch.ts:197-212` 汇总 `summary`/`status`（`batchStatus` :42：有 cancelled → cancelled；无 failed → done；best_effort 且有 done → partial；否则 failed），落 tree snapshot、run 记录、`delegate_finished` 事件，返回 `DelegateAgentBatchResult`（含 `archiveBasePath`、`eventLog`、`skillIds`、`budgetUsage`、`changeSets`、children）。
12. **进 UI**——`apps/web/src/agentNew/ui/ThoughtTraceEntries.tsx:214` 见到 `delegate_agent` 就渲染 `SubagentRunInline`；树由 `packages/subagents/src/state/subagentViewAtoms.ts:51` 从**执行图 + items** 两路派生再对账（`subagentTreeReconciliation.ts`）。

### 子 run 循环与主循环差在哪（`childAgentLoop.ts`）
- **共用**（从 `runtime/` 借的，非子 run 专有）：`modelTurn` 的 `buildTurnTools` / `narrowToolCalls` / `parseToolCallArgs` / `searchToolManifestPage`（4 处 import）、`toolGates.selectToolGate`、`finishReason`、`contextBudget` / `contextCompaction` / `contextDistillation*`、`contextCache`、`concurrencyLimiter`、`timedDispatch`、`modelSettingsProjection`、`dangerousTools`、`subagentTranscript`、`recoveryWriter`、`tools/registry`。
- **子 run 专有**：整个 `subagents/` 的 28 个源文件——自己的 prompt（`prompt.ts`）、自己的模型调用帧（`childModelClient.ts:72`）、自己的可见工具工作集（`childToolVisibility.ts`）、自己的 checkpoint（`childContextCheckpoint.ts`）。
- **差别（逐条可核）**：① 子 run **不碰会话 items/run atom**（`grep appendItem|itemsAtom|runAtom packages/agent-core/src/subagents/*.ts` 为空），历史活在 `loop.messages` 里；② **不流式**（`childModelClient.ts:101,141` `stream:false`）；③ **无插件 hook**（同目录零 `plugin` 引用），压缩改用一次性 checkpoint（`childModelClient.ts:85-128`，60k token 目标线 :34）；④ **不能 pause**：`delegationCapabilities.ts:108` 把任何 pause 转成失败；⑤ 最后一轮强制合成（`childAgentLoop.ts:201-208` 注入"到此结束"用户消息 + `toolChoice:'none'` + 空工具表）；⑥ 到点工具只有 `subagentStart` / `subagentEnd` 两个时机（`childAgentLoop.ts:135`，时机枚举在 `tools/toolCallTiming.ts:20`），且只放行 `risk==='safe'`（`childResult.ts:78`）；⑦ 工具全部经 `context.runChildTool` 借道父 `ToolContext`（`delegationCapabilities.ts:94`），白名单 = profile ∪ confirmedTools。
- **嵌套委派**：`childAgentToolCalls.ts:207-247`，子 run 调 `delegate_agent` 时把自己的 transcript 与 skill 链当继承上下文传下去，深度由 `selectToolGate` 的 `delegate.depth/maxDepth` 挡（:141-146）。

## 每部分负责什么 / 状态归谁 / 谁能调谁
| 部分 | 职责 | 持有的状态 | 谁可以调它 | 不许做 |
|---|---|---|---|---|
| `tools/agents/*` | 4 个模型可见工具：派发 / 观察 / 等待 / 取消 | 无 | 模型经 registry | 直接碰 scheduler、atom |
| `runtime/toolContext/delegationCapabilities.ts` | 委派安全边界：能力交集、`runChildTool` 闸门、归档写入器 | 无（就地挂在 ctx 上） | `toolContext.ts:144` | 放行非白名单工具、允许 pause |
| `agent-core/src/subagents`（28 源文件） | 委派协议、策略、批次编排、子 run 循环、续跑记账 | `DelegateAgentRuntimeState`（进程内、非会话状态） | core 内相对导入 + `./subagents` barrel | 依赖具体工具包、写 items/run |
| `packages/subagents`（44 文件） | 端口实现：scheduler 状态、归档 IO/writer/replay、skill 蒸馏、档位表、视图 atom | scheduler 的 `trees` Map；视图 atom（会话 store） | 装配层与 UI | 反向被 core 依赖 |
| `execution/runtime.ts` + `execution/graph.ts` | 后台执行句柄与执行图（子 agent 节点与 trace 的唯一运行态落点） | `executionGraphAtom`（会话槽位，增量记账） | core、`delegationCapabilities` | 整值写图（二次开销） |
| `state/subagentContinuationAtoms.ts` | 可恢复 child 的唯一会话状态源 | `subagentContinuationsAtom`（会话槽位） | 只有 `continuationStore.ts` | 别处 `setter` |
| `scripts/subagent-*.js` | 离线治理：复盘、容量、索引压缩、skill 状态迁移 | 归档文件 + `governance/*.jsonl` | 人在终端 | 被运行时调用 |

## 形状（分支线：目录/文件形状 + 计数；必需 vs 可选）
- `packages/agent-core/src/subagents` 成员 **53** 个（git 跟踪）：源码 **28** / 测试 **20** / 夹具与 harness **5**（`runtime.*.testFixtures.ts` 4 + `runtime.testHarness.ts`）。
- 28 个源文件按职责精确分七组：**子 run 循环 7**（`childAgentLoop` / `childAgentToolCalls` / `childModelClient` / `childResult` / `childContextCheckpoint` / `childFinishReason` / `childToolVisibility`）、**委派编排 5**（`delegationBatch` / `delegationPolicy` / `delegationRuntime` / `delegationRuntimePorts` / `delegationCallId`）、**续跑 4**（`continuationStore` / `continuationLifecycle` / `continuationDescriptor` / `continuationDescriptorParser`）、**契约与入口 4**（`types` / `index` / `input` / `prompt`）、**模型路由 3**（`routing` / `tierRouting` / `modelSelection`）、**运行时与能力 3**（`runtimeState` / `toolProfile` / `skillDistillChat`）、**树地址与调度视图 2**（`path` / `scheduler`）。7+5+4+4+3+3+2 = 28，无剩余。
- `packages/subagents/src` **44** 个：`archive/` 17、`state/` 19、根 8（`index` / `runtime` / `scheduler` / `schedulerState` / `delegationAssembly` / `defaultTierRouting` + 2 个测试）。
- `tools/agents/src` 4 个工具目录，每个都是"实现 + `.md` 指南 + `.test.ts`"三件套——**这是本域的必需形状**（`delegate-agent/` / `observe-agent/` / `join-agent/` / `cancel-agent/`）。
- 必需：工具目录三件套、域 registrar 注册（`tools/agents/src/index.ts:13`）、core 侧只经 `./subagents` barrel 出公开面（`subagents/index.ts:1-52` 写明收录判据）。可选：`packages/subagents` 的端口实现可整体替换——core 只认 6 个端口（`delegationRuntimePorts.ts:124`）。

## 样板（点名 1–2 个成员 + 为什么）
- `packages/agent-core/src/subagents/delegationPolicy.ts`——**奠基**：一次委派请求的所有"只能收紧不能放宽"判据集中在一个纯函数里，入参出参都是内核结构，是本线"预算/能力沿树单调收窄"的唯一权威处。加任何新的沿树继承字段都照它写。
- `tools/agents/src/observe-agent/observe-agent.ts`——**最简且干净**：64 行示范了本域工具的标准骨架（能力缺失先返回 `AGENT_DELEGATION_UNAVAILABLE`、入参自校验、错误分 code）。

## 加一个（触碰文件；每项标来源）
- 加一个 **agents 域工具**：`tools/agents/src/<name>/{<name>.ts,<name>.md,<name>.test.ts}` + 在 `tools/agents/src/index.ts:13` 的数组里注册——来源：已有清单（4/4 成员一致）。
- 加一个 **委派输入字段**：`subagents/types.ts`（协议词汇）→ `subagents/input.ts`（归一化+硬顶）→ `delegate-agent.ts:6` 的 `inputSchema` → 若参与继承还要进 `delegationPolicy.ts:54` 与 `delegationBatch.ts:123`；若要落归档再进 `delegationBatch.ts:65` 的 `delegate_requested`——来源：汇合点代码。
- 加一个 **归档事件类型**：`subagents/types.ts` 的 `SubagentArchiveEventType` → `packages/subagents/src/archive/replayEventSchema.ts` → `scripts/subagent-event-types.js`（CLI 复盘共用）——来源：git 配方交集（三处同改）。
- 加一个 **会话级子 agent 状态**：必须进 `state/sessionSlots.ts` 与 `scripts/state-invariants/atomDispositionTable.js:16` 的 `slotAtoms`，否则 `pnpm check:state` 直接 error——来源：门禁代码。
- 加一个 **治理脚本**：`scripts/subagent-<x>.js` + `-lib.js` + `-lib.test.js`，写文件必须经 `scripts/subagent-archive-lock.js:9` 的同一把 `<target>.archive-write.lock`——来源：已有清单（retention / index-compact / skill-governance 三者一致）。

## 标准之外
### 另一类（同目录、不同机制）
- `subagents/tierRouting.ts` + `routing.ts` + `modelSelection.ts`——不是委派机制，是**可审计的模型档位路由**：`routeSubagentModel`（`routing.ts:65`）只吃结构化可观测特征、不做关键词分类，15 个 `route_reason` 是稳定聚合标识。core 只认 Pro/Flash 两个抽象档，具体模型由装配注入（`packages/subagents/src/defaultTierRouting.ts:12`，当前只有 deepseek 一张表）。
- `DelegationRuntime.runLowCostExtraction`（`delegationRuntime.ts:38`）——挂在委派运行时上，但**跟子 agent 无关**：唯一消费方是 `tools/fs/src/find-test-lint-commands/find-test-lint-commands.ts:278`。它借用的只是"能换到 flash 档发一次无工具请求"这件事。
- `packages/subagents/src/state/` 的 19 个文件里，只有 `subagentViewAtoms.ts` 的三个 atom 是 live 视图；其余 `subagentArchive*` / `subagentRunHistory*` / `subagentTrace*` / `subagentSkillGovernance*` 读的是**磁盘归档**，是另一套（异步 loader + 文件指纹 cursor）机制。

### 漂移 / 遗留（少、晚、不合形状——引用并说明；是「别模仿」不是「删」）
- `subagents/scheduler.ts:16` `subagentScheduler`——注释自述是"legacy callers 的兼容视图"，全仓**零生产消费方**（只有同名测试）。新代码用 `CoreInstance` 私有的 scheduler。
- `continuationStore.ts:132-137`——注释直说终态 continuation "移除逻辑还没实现"，条目会一直留在槽位里；`markChildContinuationTerminal` 是 patch 不是 remove。
- `continuationDescriptorParser.ts:10` `parseChildContinuation`——三种 disposition 里 `deliver_terminal` / `await_input` **没有任何生产调用方**；恢复侧 `runtime/commands/recoveryCommands.ts:60` 只看 `subagentContinuationsAtom.length > 0` 就整会话判 `reconciliation_required`。即：续跑目前只做到"绝不静默重放"，还没做到"接着跑"。
- `delegate-agent.ts:167` 的同步 `delegateAgents` 分支——`delegationCapabilities.ts:122` 无条件挂 `spawnAgents`，`toolContext.ts:144` 又是"有 delegateRuntime 就两个都挂"，所以生产里该分支不可达。
- `runtime.toolProfileAndRegistry.test.ts` 454 行、`runtime.toolCallAndFinishReasonErrors.test.ts` 380 行——顶到 CLAUDE.md 的 300/500 行区间上沿；测试不在例外清单里，路过别再往里塞。

### 待确认（≤5；只问改变新代码去向的；点名成员；每条两种解释）
1. **续跑机制续不续做**（`packages/agent-core/src/subagents/continuationDescriptorParser.ts:10` 与 `packages/agent-core/src/runtime/commands/recoveryCommands.ts:60`）：A 现状即终态——`subagentContinuationsAtom` 只是"这会话有过子 agent，别自动恢复"的一面旗，`deliver_terminal` / `await_input` 是过度设计，新代码不要往上接；B 是没写完的一半——恢复应按 disposition 分流（终态直接交付给父、等待输入的重新挂起），新卡应先补消费方再补清除。
2. **终态 continuation 由谁清**（`packages/agent-core/src/subagents/continuationStore.ts:132`）：A 由批次聚合边界清——`delegationBatch.ts:206` 返回结果落进父 items 后统一 remove，走 `listSlotLog` 的 remove op；B 刻意永不清——它同时是"这个 run 派过哪些子 agent"的持久台账，清了就丢审计，容量交给 retention 脚本管。
3. **`delegate_agent` 的同步返回分支留不留**（`tools/agents/src/delegate-agent/delegate-agent.ts:167`）：A 留作宿主降级路径——将来可能有不装执行图的宿主只注入 `delegateAgents`，工具要能同步等结果；B 已被 `spawnAgents` 全覆盖，是死代码，`ToolContext.delegateAgents` 这条公开面也该一起收，新宿主必须实现 spawn。
4. **档位路由表要不要多厂商**（`packages/subagents/src/defaultTierRouting.ts:12`）：A 单表即够——`tierRouting.ts:13-17` 已论证跨 vendor 换档保不住会话参数，非 deepseek 会话就是保守档 + 父模型，不必扩；B 该按会话 vendor 选表——现状让 GLM/Kimi 会话完全拿不到 Flash 与 `runLowCostExtraction`，新卡应加"按 vendor 取表"的注入点。
5. **`pnpm subagent:capacity` 归哪一类**（`package.json:19`）：A 它就是一条测试断言，不是治理命令，容量口径靠 `packages/subagents/src/archive/archiveCapacity.test.ts` 钉住即可；B 它该和另外四条一样是可对真实 `.webAgent-archive/` 跑的 CLI，新卡补 `scripts/subagent-capacity.js`。

## 文档与代码不一致处
- `docs/tree-subagent-runtime.md:144` 说"父 agent 收到 `DelegateAgentBatchResult`"；代码是父 agent 收到 `executionId` 句柄——`delegate-agent.ts:164` 走 `spawnAgents`，`delegationCapabilities.ts:122` 立刻返回 `ExecutionHandle`，要拿结果得再调 `join_agent`。工具自己的指南 `tools/agents/src/delegate-agent/delegate-agent.md:3` 写对了。
- `docs/tree-subagent-runtime.md:149` 把 `packages/subagents/src/runtime.ts` 标为"调度编排"入口；代码里它只剩**端口装配 77 行**，批次编排已下沉 `packages/agent-core/src/subagents/delegationBatch.ts`（该文件头 :67-71 记了这次下沉）。
- `docs/tree-subagent-runtime.md:165,174` 的 `confirmedTools` 枚举只有 5 个；实际 schema 是 9 个（`delegate-agent.ts:53`，多出 `delete_path` / `copy_path` / `move_path` / `revert_workspace_change`）。
- `docs/tree-subagent-runtime.md:207` 说"`toolProfile` 必须显式选择，默认 `delegate_only`"——两句自相矛盾；代码是**可省略**，省略即继承父档，root 省略即 `delegate_only`（`delegationPolicy.ts:74-76`）。
- 任务书与 `CLAUDE.md` 把 `pnpm subagent:capacity` 列为"实现在 `scripts/`"的治理脚本；`package.json:19` 是 `vitest run packages/subagents/src/archive/archiveCapacity.test.ts`，`scripts/` 下没有对应文件。五条命令里只有四条是脚本。
- `CLAUDE.md`「derived 不能跨 store … subagents 的视图 atom 整族住 agent store」——**核过，属实**：`subagentViewAtoms.ts:51` 从 `subagentStatePort.executionGraphAtom` 与 `.itemsAtom`（`packages/agent-core/src/state/stateViewPort.ts:38-40`，两者都是会话 atom）派生，UI 侧 `SubagentTreePanel.tsx:34-40,275` 与 `SubagentRunInline.tsx:252` 全部用 `useAgentAtomValue`，写入一律经 `subagentCommandFacade.ts:20` 注册的 facade 再由 `runtime/commands/subagentViewCommands.ts:26` 取当前会话 store。跨 store 的后果就是规则 5 说的那种：einfach 的 derived 只在一个 store 里 `get`，把这族 atom 挂到界面 store 上不会报错，`executionGraphAtom` / `itemsAtom` 会**恒读默认值**，于是子 agent 树永远空白且无异常——所以 `subagentContinuationsAtom` 与 `executionGraphAtom` 都登记在 `scripts/state-invariants/atomDispositionTable.js:25-26` 的 `slotAtoms` 里，双向比对兜底。

## 证据核过：commit `1ebe4a0`，2026-08-20；本次打开文件数：66

## 裁决（2026-08-20，dol）

- #1 → **那两个 disposition 是过度设计（≈A），但另有新需求**（questions A5）——负责人的原话是「状态本来就在 atom 里，恢复不是问题；只怕一直死循环，能不能输出原因、关掉这个子 agent、再重开一个」。**待确认**：这理解对不对，以及「关掉再重开」现在有没有（我尚未核实）。
- #2 → **随 #1**（questions A5）——终态 continuation 的清除策略等 #1 定了再定。
- #3 → **删**（questions D1）——`delegate_agent` 的同步返回分支删掉，`ToolContext.delegateAgents` 这条对外能力一起收；新宿主必须实现 spawn。
- #4 → **按 vendor 选表**（questions A9）——档位路由要认厂商，GLM/Kimi 会话不该完全拿不到低成本档。
- #5 → **干掉它**（questions C7）——`pnpm subagent:capacity` 这条命令删掉，不补脚本；容量口径仍由 `archiveCapacity.test.ts` 钉住。
