# 线：一次 run 的执行链路

一句话：把一条用户消息变成「组请求 → 拿响应 → 跑工具 → 回填 → 再组请求」的有界循环，直到某个出口把 run 停在一个已落盘的状态上。
类型：主线——挂在 `packages/agent-core/src/runtime/runToolLoop.ts:37`（运行时）与 `packages/agent-core/src/runtime/commands.ts:44`（命令面）

## 入口（一个实例从哪开始；引 file:line）

- UI：`apps/web/src/agentNew/ui/Composer.tsx:111` 调 `sendMessage(input)`；CLI 单轮是 `apps/cli/src/bootstrap.ts:47`。两条都只调命令，不碰 writer。
- 命令实现：`packages/agent-core/src/runtime/commands/runLifecycleCommands.ts:49`（`sendMessage`）。同文件另两个入口：`continueInterruptedRun`（:103）、`continuePlan`（:127）。
- 稳定导出面只有 4 个符号：`packages/agent-core/src/runtime/modelRun.ts:8-13` 把 `runSession` / `resumeInterruptedSession` / `resumePlanSession` / `runToolLoop` 从 `runToolLoop.ts` 原样转出，命令层只 import 这一个路径。
- 暂停后的第二类入口：`runtime/commands/runCommands.ts:60` `resumePausedRun` —— 它**不新建 runId**，用原 `run.runId` 重进 `runToolLoop`。

## 数据怎么走（逐步；每步引 file:line）

1. **提交闸门** → `runLifecycleCommands.ts:61` `scheduleSessionSubmission`：同一会话的提交串行排队（`sessionSubmissionGate.ts:57`），闸门内先跑 `core.config.prepareUserInput`（图片上传等宿主动作，:96），再进 `commit`。准备失败/被中止时 `preparedUserInputTransaction.ts:14` 负责回滚已上传内容。
2. **commit 三岔**（`runLifecycleCommands.ts:71-92`）：run 是 `running`/`awaiting_tool` → `enqueueUserMessage` 入队，返回 `queued`（:73）；run 是 `waiting_*`/`interrupted` → `rejected('run_blocked')`（:83）——暂停期不许插一条普通用户消息破坏 tool-call 配对；否则 `withRun` 起 run（:91）。
3. **拿 AbortSignal** → `runCommands.ts:39` `withRun`：`core.abort.beginRun(id)`，同会话的旧 controller 当场被 abort（新 run 顶掉旧 run），`finally` 里 `endRun(id, signal)` 只在 signal 仍是登记那一份时才清（`abortRegistry.ts:22-26`）。
4. **开 run** → `modelRunLifecycle.ts:72` `startModelRun`：生成 `runId` + `userItemId`（同时当 `turnId`）→ 开 `agent.turn` span（:77）→ `appendItem` 写用户消息（:80）→ `setRun({status:'running'})`（:81）→ **`persistBeforeModelLoop('model_run_started')` 没确认就直接 return**（:82）。
5. **bootstrap** → `toolLoopBootstrap.ts:31`，一个 run 只跑一次：会话存在性（:36）→ `toolEpochs.ensure`（:45，同 runId 重入复用同一份工具集快照）→ `plugins.activateRun` + `onRunStart`（:46、:54）→ **`buildStableModelPrefix` 只在这里调一次**（:76）→ 三道守卫（:77-79）→ `injectStablePrefixTranscript` 镜像给 UI（:80）→ delegation runtime（:85）→ 从 `session.loadedTools` + 历史 + `run.loadedTools` 恢复已加载工具（:92-94）→ `bindTimedToolDispatcher`（:127）→ `sessionStart`、`runStart` 两个到点分派（:133、:138）。
6. **外层循环** → `runToolLoop.ts:108` `for (turn; budget.allows(turn); turn++)`。每轮：请求前 `turnStart`（:119-122），`finally` 里 `turnEnd`（:136-139），整个 run 的 `finally` 里 `runEnd`（:171）。`resumeToolCall` 存在时先在循环外把那一个被确认的调用执行掉再进循环（:74-104）。
7. **一轮的编排** → `toolLoopCycle.ts:31`：`promoteQueuedInputs` 把排队消息转成 items 并抬高预算（:41-45）→ 组尾巴 controls（:56-71）→ `requester.request`（:73）→ 异常 finish_reason 补提示（:96-97）→ `onTurnEnd`（:98）→ `shouldStop`（:120）→ `streamWriter.finalize`（:140）→ 无 tool_calls 走 `handleTextTurn`（:142），有 tool_calls 走 `runToolCallBatch`（:167）。
8. **组请求** → `modelTurnRequester.ts:54`（见下节）。
9. **跑工具** → `toolCallBatch.ts:47`：闸门 → 校验 → 插件前置 → 风险 → 执行围栏 → 执行 → 回填（见下节）。
10. **结果去哪** → 每条工具回执经 `toolLoopSupport.ts:69` `appendToolResult` 写成 `role:'tool'` item 并 fire-and-forget 落一次恢复快照（:77）；一轮的耐久性栅栏由 `requireRecoveryDurability`（`recoveryDurabilityBarrier.ts:8`）9 处调用点把住；文本收尾时 `patchRun({status:'done'})` + `persistSessions()`（`toolLoopTextTurn.ts:74-77`）。

### 一次请求的 message 数组是怎么拼出来的

- **稳定前缀 4 段，顺序写死在一处**：`modelTurnPrefix.ts:79-84` = ①固定 system（只剩收尾自查/如实报告两条，`modelTurnSystemItems.ts:26`）②工具摘要清单（`toolManifest.ts:57`，只有 name/description/runtime）③自定义指令（可选，`modelTurnSystemItems.ts:107`）④运行环境（`modelTurnSystemItems.ts:63`）。整个 run 内逐字不变——它在 bootstrap 建一次，之后每轮从 `base.stablePrefix` 取。
- **顺序理由是 provider 前缀缓存**：按会话变化的那段必须最靠后，否则一变就从 token 0 打断缓存（`modelTurnSystemItems.ts:15`、:100-106 写明自定义指令曾放在历史之后、实测每轮全额 miss）。
- **中段 = 会话 items 的投影**：`modelTurnRequester.ts:85` `projectContextCheckpoint(history, checkpointAtom)`——有 checkpoint 且它覆盖的 id 前缀逐个对得上时，把被覆盖的那一段换成一条摘要 item（`contextCheckpointProjection.ts:29`）；对不上就整份丢弃并清 checkpoint（:24、requester :86-89）。
- **尾巴 controls 最多 4 条 `role:'system'`**，每轮重算：`plan_definition` / `plan_state` / `plan_continuation` / `tool_failure_notice`（`toolLoopCycle.ts:56-71`）。`planContinuation` 是一次性的，用完即清（:72）。
- **三次快照，一次落地**：`rawMessages = 前缀 + 全量历史 + controls`（`modelTurnRequester.ts:83`，只作诊断基线）→ `projectedMessages = 前缀 + 投影历史 + controls`（:91，超预算时先 `createContextCheckpoint` 蒸馏再重算，:92-128）→ `transformContext`（:153）→ `prepareRequest`（:159）→ `projectTimedToolResultOrphans(draft.messages)`（:167）才是真正发出去的 `messages`（:178）。
- **tools 数组另有一条线**：`refreshVisibleTools`（:57）→ 计划期 pin（:61）→ `buildTurnTools`（:70）。读的一律是**本 run 的 toolEpoch**，不是活 registry——registry 在 run 中途变了也不改本 run 已组装的清单（:56 注释）。

### 循环怎么决定继续 / 暂停 / 结束

- **预算**：`createLoopBudget(maxAgentTurns(...))`（`runToolLoop.ts:105`）。排队消息每促成一条抬 1（`loopBudget.ts:18`），计划执行期取 `阶段数 × 500 + 1` 的地板（`toolLoopPlan.ts:60-66`）。用尽 → `status:'error'` + `agent.max_turns`（`runToolLoop.ts:147-150`）。
- **结束**：文本轮且非计划期且无排队 → `done`（`toolLoopTextTurn.ts:75`）；空回复 → `error`（:25）；计划期连续 2 个文本轮 → `error: 计划执行连续 2 轮未调用工具`（:42-51）；插件 `onTurnEnd` 返回 `{stop:true}` 或 `shouldStop` 返回决定 → 按插件给的 `runStatus` 停（`toolLoopCycle.ts:100-139`）。
- **暂停三态，全在 `toolCallBatch.ts` 结尾**：`waiting_confirmation`（:171，危险/critical 工具）、`waiting_plan_approval`（:186，pause 载荷是 `kind:'plan_approval'`）、`waiting_user`（:190，`ask_user_question` 的 pause）。三者都先过 `requireRecoveryDurability` 才返回 `'paused'`，没落住就是 `'interrupted'`（:172、:192）。
- **一批里只允许一个暂停**：`interruptPending()`（:51）——第二个想暂停的调用直接收到一条错误回执（:127、:162），协议配对不许缺。
- **恢复**：`resumeWithAnswers`（`runCommands.ts:86`）先 `appendToolResult` 回填答案再 `resumePausedRun`；`confirmTool`（:119）判 `checkPendingToolRegistration`——拒绝/服务已断开就地回执（:167、:188），批准则把 `pending` 当 `resumeToolCall` 传回循环（:196），由 `runToolLoop.ts:74-104` 直接执行、跳过闸门重判（`beforeToolHookCompleted` 为真时连 `beforeToolCall` 也不重放，:83）。`approvePlan`（`planCommands.ts:96`）同形。

### 工具结果怎么回填

`toolCallBatch.ts` 的单条路径：JSON 解析失败就地回执（:79-87）→ `handleToolGate` 处理所有「不执行也要回一条」的情形（:90，含 retired 工具、未连接服务、schema 懒加载、注册版本变更）→ 形状校验（:91）→ `prepareToolCall`（:103，schema 校验 + `beforeToolCall`）→ `classifyToolRisk` + 确认判定（:123-125）→ `persistToolCallExecutionFence`（:154）→ `executePreparedToolCall`（:157）→ `appendMappedToolResult`（:165）。
并行只在**整批**都满足条件时才走（:64：无 tool hooks、全部 `mode:'parallel'`、注册版本一致、风险 safe、条数 >1），否则整批退回串行。
`appendMappedToolResult`（`toolLoopSupport.ts:81`）把 `ToolResult` 序列化成模型看到的形状；`pause` 走不到这里（在 batch 里被截成暂停）。

### 九个 callTiming 时机分别在哪触发

枚举在 `packages/agent-core/src/tools/toolCallTiming.ts:12-22`。**9 个里主循环直接分派 5 个**：`sessionStart`/`runStart`（`toolLoopBootstrap.ts:133`、:138）、`turnStart`（`runToolLoop.ts:121`）、`turnEnd`（:138）、`runEnd`（:171）。**2 个经插件回调**：`preCompact`/`postCompact` 的唯一触发点是 `compactionPlugin.ts:346`、:422，而回调本身由 `modelTurnRequester.ts:141-149` 挂进 draft，且只在这两个桶有注册时才挂（:129-131）。**2 个在子 Agent 循环**：`subagentStart`/`subagentEnd`（`packages/agent-core/src/subagents/childAgentLoop.ts:135`）。
到点工具**不进模型可见面、不经确认门**，因此分派器执行前自己判风险，非 `safe` 一律拒执行并记诊断（`timedDispatch.ts:153-164`）。幂等靠 `timedCallId` 的分层 id（:82-88）与「这条 tool item 是否已在历史里」（:90-98）。

### AbortSignal / runId stale guard / ghost guard 在哪些点位生效

- **ghost guard 的判据只有一处**：`shared/runGuards.ts:13` `isCurrentRun` = 会话仍登记在 rootStore **且** `runAtom.runId` 等于发起时的 runId。两件事合成一个函数，所以「幽灵会话」和「被顶掉的旧 run」在全仓是同一道闸。writer 层另有一份独立的 ghost guard（`state/sessionWriters.ts:33`）。
- **循环层**：`runToolLoop.ts:45-66` 的 `endInactive` 三查（:46 stale / :51 not-running / :57 aborted），在 `resumeToolCall` 前后（:93、:98、:100）、cycle 入口（`toolLoopCycle.ts:40`）与每个 await 之后（:78、:99、:129）被调；请求前另有一处内联三查（`runToolLoop.ts:124`）。全文件 9 行含此类判定。
- **批次层**：`toolCallBatch.ts:52` `statusAfterAwait` 把三态映射成 `'stale' | 'stopped' | 'aborted'`，在围栏前后与执行后各查一次（:66、:69、:155、:158）。
- **请求层**：`modelTurnRequester.ts` 共 6 行含守卫——完整三查 4 处（:109 蒸馏后、:154 `transformContext` 后、:164 `prepareRequest` 后、:196 响应后），重试观察器一处（:181），失败回写只查 `isCurrent`（:189）；`streamModel` 直接吃 `base.opts.signal`（:52、:183）。
- **工具层**：`ToolContext` 的 `assertFresh`（取消或被顶掉都算 stale）与 `assertArchiveCurrent`（取消后仍写审计，但被顶掉的旧 run 绝不串写归档）——`runtime/toolContext/staleGuards.ts:20`、:25。
- **流式写入层**：`assistantStreamWriter.ts:22` `canWrite = !aborted && isRunningRun`；`finishPending` 用的是 `isCurrentRun`（:81），因为 run 已经不 running 时那条 pending item 仍要收尾。

## 每部分负责什么 / 状态归谁 / 谁能调谁

| 部分 | 职责 | 持有的状态 | 谁可以调它 | 不许做 |
|---|---|---|---|---|
| `commands/runLifecycleCommands.ts` | 起/停/续 run 的唯一命令面 | 无（读 rootStore、写经 writer） | UI、CLI、插件 command facade | 直接进循环、直接 setter atom |
| `modelRunLifecycle.ts` | 三种开场的状态铺垫 + 落盘前置 | 无 | 只有 `runToolLoop.ts:22-34` 三个 facade | 组请求、跑工具 |
| `toolLoopBootstrap.ts` | 一个 run 的一次性依赖装配 | 产出 `ToolLoopBase`（含 stablePrefix、toolEpoch、hooks） | `runToolLoop.ts:38` | 发模型请求 |
| `runToolLoop.ts` | 外层状态机：预算、到点时机、终止归类 | 循环局部（turn、budget、failures） | `modelRun.ts` 转出的四个符号 | 组 message、判工具风险 |
| `toolLoopCycle.ts` | 一轮的编排与插件决策落地 | `base.state.planContinuation` 等轮内状态 | `runToolLoop.ts:131` | 直接调 provider |
| `modelTurnRequester.ts` | 组投影 + 发一次流式请求 + 记 cache/telemetry | `cacheTracker`（run 内） | `runToolLoop.ts:107` 包一层后 | 决定循环是否继续 |
| `toolCallBatch.ts` | 一批 tool_calls 的完整处理与暂停判定 | `pauseCall` / `confirmCall`（批内） | `toolLoopCycle.ts:167` | 直接写 run 终态 |
| `toolCallGate.ts` | 「不执行也要回一条」的全部分支 | 改 `base.state.visible` / `recentToolNames` | `toolCallBatch.ts:90` | 执行工具 |
| `toolCallExecutor.ts` | 经执行图跑一次工具 | 无 | batch / timedDispatch | 判风险、判确认 |
| `timedDispatch.ts` | 到点桶的分派与幂等 | 无（epoch 在 runAtom） | 循环 + `core.dispatchTimedTools` | 走 `beforeToolCall` 确认门 |
| `recoveryDurabilityBarrier.ts` | 「快照没确认就把 run 判 interrupted」 | 无 | 9 个调用点 | 静默吞失败 |

## 形状（主线的必经文件链 + 计数）

- 必经的非测试文件 **12 个**：`commands/runLifecycleCommands.ts` → `commands/runCommands.ts`（withRun/resume）→ `modelRun.ts` → `modelRunLifecycle.ts` → `runToolLoop.ts` → `toolLoopBootstrap.ts` → `toolLoopCycle.ts` → `modelTurnRequester.ts` → `modelTurnPrefix.ts` → `toolCallBatch.ts` → `toolCallExecutor.ts` → `toolLoopSupport.ts`。
- 旁挂但每轮都会碰到的 **5 个**：`toolCallGate.ts`、`timedDispatch.ts`、`recoveryDurabilityBarrier.ts`、`toolCallExecutionFence.ts`、`assistantStreamWriter.ts`。
- 落盘点位计数：`persistBeforeModelLoop` 3 处（`modelRunLifecycle.ts:82`、:96、:116）；`requireRecoveryDurability` 9 处；`persistToolCallExecutionFence` 4 处（`runToolLoop.ts:97`、`toolCallBatch.ts:65`、:154、`timedDispatch.ts:151`）；`runtime/` 下 `persistRecovery(` 共 24 处（含定义与 fire-and-forget）。
- 插件 hook 槽 **7 个**（`core/loopHooks.ts:164-190`），主循环调用点也是 7 处：`onRunStart`（`toolLoopBootstrap.ts:54`）、`transformContext`（`modelTurnRequester.ts:153`）、`prepareRequest`（:159）、`beforeToolCall`（`toolCallPluginHooks.ts:65`）、`afterToolCall`（:113）、`onTurnEnd`（`toolLoopCycle.ts:98`）、`shouldStop`（:120）。默认装配的插件只有 **3 个**（`core/plugins/defaultPlugins.ts:7-11`），只占 2 个槽：`onRunStart`（migration，`migrationPlugin.ts:59`）与 `onTurnEnd` ×2（`loopGuardPlugin.ts:184`、`finishReasonPlugin.ts:107`）。
- 必需 vs 可选：必需 = 上面 12 条链；可选 = `delegation`（`toolLoopBootstrap.ts:85`，缺席时 `delegateRuntime` 为 undefined）、`planRuntime`、观测 driver、持久化 driver（未配置时 `persistRecovery` 返回 undefined，barrier 一律判通过，`recoveryDurabilityBarrier.ts:16`）。

## 样板（点名 1–2 个成员 + 为什么）

- `packages/agent-core/src/runtime/runToolLoop.ts`——**奠基且最简**：181 行里没有一句业务判定，只有「什么时候分派到点工具、什么时候认定不该继续、异常怎么归类」三件事。看懂这一个文件就拿到了整条线的骨架；要加一个新的循环级点位（新到点时机、新终止归类），形状照它。
- `packages/agent-core/src/runtime/toolCallBatch.ts`——**最近且干净**的分支处理样板：每一条「不执行」的岔路都在原地写完回执再 `continue`，从不把「回执由谁写」推给调用方。工具协议要求 tool_call 与 tool result 一一配对，这个形状是那条不变量的实现方式。

## 加一个（触碰文件；每项标来源）

- **加一个 callTiming 时机**——来源：汇合点代码。`tools/toolCallTiming.ts:12`（加枚举成员，或直接用 `<domain>:<event>` 不改这里）+ 分派点（主循环内加在 `runToolLoop.ts`，宿主侧走 `core.dispatchTimedTools`）+ `timedDispatch.ts:82` `timedCallId`（新时机的 id 分层与幂等键）。
- **加一段稳定前缀**——来源：汇合点代码。`modelTurnSystemItems.ts`（新 builder）+ `modelTurnPrefix.ts:79-84`（插进顺序里，按会话变化的必须靠后）+ `modelTurnPrefix.ts:16-32`（`StableModelPrefix` 字段）+ `transcriptInjection.ts:54-93`（UI 镜像的指纹表）+ `contextCache` 的 `systemContent` 归因（`modelTurnRequester.ts:170` 传的是 `base.stablePrefix.content`，新段自动并入）。
- **加一条尾巴 control**——来源：汇合点代码。`toolLoopCycle.ts:54-71`（push item + push source）+ `contextRequestAssemblyDiagnostics.ts` 的 `RequestControlSource` 联合类型。
- **加一个横切行为（重试策略、新的停止判据）**——来源：已有清单 + 汇合点代码。优先落 `core/loopHooks.ts` 的 7 个槽，写成 `core/plugins/xxxPlugin.ts` 并登记进 `defaultPlugins.ts:7-11`；**登记这一步会被忘**——`compactionPlugin` 就是写完没登记的现存例子（见「漂移」）。
- **加一种暂停态**——来源：汇合点代码。`toolCallBatch.ts:169-194`（判定与落 run 状态）+ `state/core.type` 的 `RunStatus` + 一个恢复命令（照 `runCommands.ts:60` `resumePausedRun`）+ `runLifecycleCommands.ts:83` 的 `run_blocked` 名单。

## 标准之外

### 另一类（同目录、不同机制）

- `timedDispatch.ts` / `timedDispatchLoop.ts`——**不是**模型驱动的工具调用：模型看不见这些工具（`toolCallTiming.ts:5`），不经 `handleToolGate`、不经 `beforeToolCall` 确认门，风险判定改由分派器自己做（`timedDispatch.ts:153`）。它借用同一个 `executeToolCall` 和同一套回填，但决策链是另一条。
- `execution/runtime.ts` 的执行图——工具执行时被 `toolCallExecutor.ts:50` 包了一层，但它管的是「进程内 Promise 与取消」，与本线的 run 生命周期是两套 id（`graphId` 恰好取 runId，:52）。
- `contextCache.ts`——只观察不改动：它算 profile/lane/epoch 供 trace 与 UI 归因，从不决定发什么（`modelTurnRequester.ts:170` 的返回值只进 trace 与 contextStats）。

### 漂移 / 遗留（少、晚、不合形状——引用并说明；是「别模仿」不是「删」）

1. **`core/plugins/compactionPlugin.ts:479` 写好了但没有任何生产装配点**。全仓（排除 `dist/`、测试）只有两处引用：`modelTurnRequester.ts:5` 引它的**类型** `CompactionRequestDraft`，以及 `compactionProjectionCache.ts` 引它的注释。`defaultPlugins.ts:7-11` 里没有它。后果是三重的：`transformContext` 槽在默认装配下**无人注册**；`preCompact`/`postCompact` 两个时机在生产里**永不触发**（它们的唯一触发点在这个插件内）；而真正在跑的上下文瘦身是 `modelTurnRequester.ts:92-128` 里内联的 distillation（`contextDistillation.createContextCheckpoint`）。**别模仿**「写插件不登记」，也别照 CLAUDE.md 的说法去 compactionPlugin 里改压缩行为——改了不生效。
2. **`modelTurnSystemItems.ts:9-13` 的注释声称 skill 全量清单「与固定 system 同区进稳定前缀」**，但 `buildStableModelPrefix`（`modelTurnPrefix.ts:79-84`）只组 4 段，没有 skill 清单；`buildSkillManifestText` 全仓只被 `tools/skills/src/skill-manifest/skill-manifest.ts:25` 这个**工具**调用。注释描述的是一个没有落地（或已撤回）的形态。
3. **同文件 :15 与 :55 声称「运行环境是稳定前缀里唯一按会话变化的一段，故排在其它前缀段之后」**，而排在它**前面**的工具摘要段（索引 1）读的是本 run 的 toolEpoch（`modelTurnPrefix.ts:64`），MCP 接入/断开会让它逐会话、逐 run 变。顺序理由与事实对不上——按前缀缓存的逻辑，会变的那段排在靠前位置代价更大。
4. **`runtime/abortRegistry.ts:13-35` 五个模块级导出仍硬绑 `defaultCore`**（文件头自陈是「defaultCore 的视图」）。主线自己已经不用它们（`runCommands.ts:39` 走 `core.abort.*`），但它们仍在导出面上，`createCore()` 的隔离实例用到就会串到默认实例。属于遗留，别在新代码里 import。
5. **`toolLoopCycle.ts:98-139` 里 `onTurnEnd` 与 `shouldStop` 两个槽的停机语义高度重叠**（一个返回 `{stop, runStatus, reason}`，一个返回 `{runStatus, reason, checkpoint}`），默认三插件全部挂在 `onTurnEnd`，`shouldStop` 无人注册。不是错，但新增停机判据时会面对「该挂哪个」的真实歧义。

### 待确认（≤5；只问改变新代码去向的；点名成员；每条两种解释）

1. **compactionPlugin 是该装配还是该删**（`packages/agent-core/src/runtime/core/plugins/compactionPlugin.ts:479`、`core/plugins/defaultPlugins.ts:7-11`）：A 它是遗漏登记，应加进 `defaultCorePlugins`，`preCompact`/`postCompact` 两个时机随之复活，`transformContext` 槽有主；B 它已被 `modelTurnRequester.ts:92-128` 的内联 distillation 取代，应连同两个 compact 时机与 CLAUDE.md 的「压缩是插件」一起清掉。两条路对「以后改上下文瘦身该动哪个文件」给出相反答案。
2. **`preCompact`/`postCompact` 算不算「九个核心时机」的在编成员**（`packages/agent-core/src/tools/toolCallTiming.ts:12-22`）：A 算，只是当前触发方缺席，宿主注册这两个桶的工具是受支持的用法，需要补一条不依赖 compactionPlugin 的触发路径；B 不算，枚举该收缩到实际会触发的 7 个。这决定新写的到点工具能不能挂这两个桶。
3. **稳定前缀里工具摘要段的位置**（`packages/agent-core/src/runtime/modelTurnPrefix.ts:79-84`）：A 顺序是刻意的（清单必须先于环境说明出现，缓存代价接受），注释里「唯一按会话变化」的说法该改；B 顺序是历史遗留，会随 MCP 变的清单应挪到环境段之后，与注释声明的原则对齐。这决定以后往前缀里加段落时插在哪。
4. **`shouldStop` 槽的定位**（`packages/agent-core/src/runtime/core/loopHooks.ts:186-190`、`toolLoopCycle.ts:120`）：A 它是给宿主插件留的公开停机面，core 自带插件按约定只用 `onTurnEnd`；B 两个槽应合并，新判据一律走 `onTurnEnd`。这决定下一个停机类插件挂哪个 hook。

## 文档与代码不一致处

- `CLAUDE.md`「运行链路」第 4 步说九个核心时机「由 `timedDispatch.ts` 在相应点位执行」；代码里 9 个时机中主循环只分派 5 个（`toolLoopBootstrap.ts:133`、:138，`runToolLoop.ts:121`、:138、:171），2 个在子 Agent 循环（`subagents/childAgentLoop.ts:135`），2 个只由未装配的 compactionPlugin 触发（`compactionPlugin.ts:346`、:422）。
- `CLAUDE.md` 说「压缩、finish reason、loop guard、迁移这些横切行为是 `runtime/core/plugins/` 里的插件」；四者里只有后三个真的装配了（`core/plugins/defaultPlugins.ts:7-11`），压缩的实际实现是 `modelTurnRequester.ts:92-128` 的内联 distillation。
- `docs/core-runtime-flow.md:39` 的流程图节点「压缩并组装模型上下文」同上；:95-99 「`timedDispatch.ts` … 在九个核心时机 … 按注册顺序执行」同上。
- `docs/core-runtime-flow.md:52` 画的收尾是 `DONE --> CHECKPOINT[提交 checkpoint 并持久化]`；代码里 checkpoint 是**请求组装期**按预算触发的（`modelTurnRequester.ts:92`），文本收尾只做 `persistSessions` + `patchRun('done')`（`toolLoopTextTurn.ts:74-77`）。
- `docs/core-runtime-flow.md:105` 说计划审批「计划进入 `awaiting_approval`」；run 状态名实为 `waiting_plan_approval`（`toolCallBatch.ts:186`）。
- `packages/agent-core/src/runtime/modelTurnSystemItems.ts:9-13` 与 :15 的两处注释见「漂移」2、3。

## 证据核过：commit `1ebe4a0`，2026-08-20；本次打开文件数：48

## 裁决（2026-08-20，dol）

- #1 → **删**（questions A1）——`compactionPlugin` 连同 `compactionProjectionCache.ts` 与 4 个测试（6 文件 / 1648 行）清掉；新插件不要拿它当形状参考，`CompactionRequestDraft` 要换个家。
- #2 → **保住九个**（questions A2）——给 `preCompact`/`postCompact` 补一条**不依赖 compactionPlugin** 的触发路径，接到 `modelTurnRequester.ts:85-128` 的 checkpoint 蒸馏上。到点工具可以继续挂这两个桶。注意它与 #1 的先后：先补触发路径，再删插件。
- #3 → **未提交**——合并时按 question-filter 判为「不改变新代码去向」而砍掉，保持未决。前缀四段的顺序（工具摘要在环境之前）与 `modelTurnSystemItems.ts` 注释自称的原则仍相互矛盾。
- #4 → **未提交**——同上。`shouldStop` 无人注册这件事仍是已知债，不是缺陷。
- **方向裁决（全仓，questions B2 / 本轮追认）**：agent 循环目标跑在**服务端**，前端纯展示，
  tools 与 mcp 的逻辑都在后端。本线正文描述的是**当前**形态，不是目标形态——循环搬到服务端后，「稳定前缀怎么拼」「谁写 items」这些不变，变的是它在哪个进程里执行、以及 UI 怎么拿到 timeline。
