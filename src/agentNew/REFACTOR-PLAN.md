# agentNew 重构梳理(设计文档,非代码)

> 角色约定:本文是**实现前的梳理**。你主导写码,本文只给结构、不变量、落地顺序。
> 旧实现:`src/agent`(loop.ts 1324 行是要拆的主体)。

## 0. 已锁定的决策

| # | 决策 | 选择 |
|---|------|------|
| 1 | run 身份怎么传 | **显式小三元组 `RunCtx = {sessionId, runId, signal}`**,其余一切从 atom 取 |
| 2 | 本轮搬运范围 | **loop + coreState + persistence**;agents/model/skills/tools 暂从旧 `src/agent` import |
| 3 | store/切换 | agentStore 单例的家落在 `agentNew/coreState.ts`,旧 `src/agent/state/atoms.ts` 改为从 agentNew re-export → **全程一个 store**,UI 逐个切,绝不分裂 |

## 1. 核心洞察:"随时可取"的边界

- **一坨数据**(messages / runs / timeline / 记忆 / artifacts / cards)→ 全是 `Record<sessionId, T>` 的 atom,随时可取。✓
- **唯一例外**:"我是哪个 run"(sessionId / runId / signal)**不能**做成全局 atom——两个 run 可并发(用户跑一半切会话),新 run 还会顶掉旧 run。一个全局 `currentRunId` 会让两个 run 互相读到对方身份。
- **红利**:老代码 `(store, sessionId, runId, signal, input, answerContext, artifacts, loadedSkills, loadedTools, conversationContext, ...)` 的大参数包,塌缩成只剩 `RunCtx` 这 3 个身份字段——其余全用 sessionId 从 atom 取。

```ts
// runtime/runCtx.ts —— 唯一甩不掉的"参数"
export interface RunCtx {
  readonly sessionId: string
  readonly runId: string
  readonly signal: AbortSignal
}
```

```ts
// 改造前(后端式大参数包)
async function runRuntimeTool(context: AgentContext, call: ToolCall) { /* context 里塞十几个字段 */ }

// 改造后(身份三元组 + 从 atom 取)
async function runRuntimeTool(ctx: RunCtx, call: ToolCall) {
  const run = getRun(ctx.sessionId)        // atom
  const skills = run.loadedSkills          // atom
  // ...只在 abort/写回时用 ctx.signal / ctx.runId
}
```

## 2. loop 拆分(1324 行 → 15 文件,按 import 方向自下而上分层)

> 分层顺序 = 依赖方向,杜绝循环依赖(拆分最大的技术风险)。上层只能 import 下层。

| 层 | 文件 | 内容 | 旧 loop.ts 行 |
|----|------|------|------|
| **L0 纯函数** | `runtime/toolFormatters.ts` | `formatLoadedToolResult` / `formatRenderCardResult`(导出供测试)/ `format*Preview` / `byteLength` / `asRecord` | 739–746, 941–954, 1047–1070, 1029 |
| **L0 纯函数** | `runtime/payloadNormalizers.ts` | `normalizeBrowserCardPayload`(导出供测试)/ `normalizeAskUserQuestionPayload` / `isWorkerAgentId` / `isQuestionType` / `normalizeStringList` | 958–1043 |
| **L1 基础设施** | `runtime/abortRegistry.ts` | `activeControllers` **模块单例(非 atom)** + `wait(ms,signal)` + `abortSessionRun` | 56, 64–75, 1280 |
| **L1 基础设施** | `runtime/runCtx.ts` | `RunCtx` 类型(§1 的身份句柄) | 新增 |
| **L2 守卫** | `runtime/guards.ts` | `sessionExists` / `isCurrentRun` / `isAbortError`(直接读 atom) | 1291–1313 |
| **L3 副作用原语** | `runtime/timeline.ts` | `addTimeline` / `updateTimeline` + 流式进度 `createModelStreamProgress` / `formatModelStreamProgress` / `clipProgressText` / `describeAgentTurnResult` | 1103–1185, 1254 |
| **L3** | `runtime/askUserQuestion.ts` | 暂停/提问/恢复整条流:`formatAskUser*` / `hasAnswerContext` / `formatUserAnswers` + executeRun 内联的 `waiting_user` 暂停块 | 750–770, 1317, +320–348 |
| **L3** | `runtime/answerStreaming.ts` | `streamAssistantAnswer`(8 字/块 + 18ms,abort 感知) | 1224–1250 |
| **L3** | `runtime/toolLoading.ts` | `ensureToolLoaded` + `appendVisibleTool`(懒加载 schema 唯一闸门) | 1189–1220, 774 |
| **L4 执行** | `runtime/toolExecution.ts` | `runRuntimeTool` / `executeRuntimeToolCall`(skill_search/skill_read/delegate_agent/save_file/browser_action 分发) | 781–932 |
| **L5 模型循环** | `runtime/modelToolLoop.ts` | `resolveAgentTurn`(MAX_AGENT_TURNS 状态机)+ `runAgentTurn` | 403–735, 1074 |
| **L6 编排** | `runtime/pipeline.ts` | `executeRun`(架构师 plan → 技能/工具扫描 → workers 并行 → deputy merge → 模型循环 → 流式/暂停 → fire-and-forget summary) | 176–399 |
| **L7 入口** | `runtime/runLifecycle.ts` | `startAgentRun` / `continueAgentRunWithAnswers` / `stopActiveRun` / `cancelSessionRun`(⚠️ 删掉旧 82 行的 `debugger`) | 79–172 |
| **L7** | `runtime/index.ts` | 对外 barrel,UI/测试只从这一个路径 import | — |

依赖 DAG(只允许向下指):

```
L7 runLifecycle ─► pipeline ─► modelToolLoop ─► toolExecution ─► toolLoading
                      │            │                │               askUserQuestion
                      │            │                │               answerStreaming
                      └────────────┴────────────────┴─► timeline ─► guards ─► coreState
                                                         runCtx / abortRegistry(L1 叶子)
                                                         toolFormatters / payloadNormalizers(L0 叶子)
```

> 注意潜在环:`describeAgentTurnResult`(timeline)要用 `normalizeAskUserQuestionPayload`。把该 normalizer 放 **L0 payloadNormalizers**(纯函数),timeline 引 L0 即可,不形成环。

## 3. state 拆分

| 文件 | 装什么 |
|------|--------|
| `coreState.ts` | **`agentStore = createStore()` 单例**(全树唯一)+ 持久化核心 atom(sessions / activeSessionId / messagesBySession / runsBySession / timelineBySession / conversationMemoryBySession)+ 派生 `active*` 选择器(经 activeSessionIdAtom)+ `createId`/`now`/seq + 种子会话 |
| `state/coreHelpers.ts` | 核心 atom 写入器:`appendMessage` / `updateMessage` / `appendTimelineEvent` / `updateTimelineEvent` / `setRunState` / `patchRunState` / `setSessionStatus` / `getConversationMemory` / `setConversationMemory`,均带 RF8 幽灵会话守卫 + `updatedAt` 同步;**入参带显式 sessionId,但内部读写单例 store(不收 store 参数)** |
| `state/sessionLifecycle.ts` | `createSession` / `selectSession` / `deleteSession`(RF1 先改 active 指针,再多 atom 拆除:messages/timeline/runs/answers/artifacts/attachments/memory/cards)——唯一同时动核心+瞬态两层的地方 |
| `state/transientState.ts` | 不持久化的 atom(keyed by sessionId):pendingArtifacts / browserCards(§1.2 accepted-strict 的 `{ok, cardId}` 契约)/ attachments / pendingQuestionAnswers(+派生视图)/ composerDraft;BrowserCard/PendingArtifact/ComposerAttachment 类型也住这 |
| `state/persistence.ts` | 快照类型 + `parseSnapshot` / `captureSnapshot` / `applySnapshot` / `normalizeRestoredState` / `hydrateFromStorage`(load/validate/apply/subscribe 编排) |
| `state/persistenceDriver.ts` | 存储驱动(Memory / IndexedDb)+ 校验谓词——把 I/O 与状态形状解耦,可独立替换 |
| `state/index.ts` | barrel:re-export 上述全部,UI 从单一路径 import |

迁移桥(决策 3):旧 `src/agent/state/atoms.ts` 内容清掉,改成 `export * from '@/agentNew/state'`(或精确 re-export),旧 import 站点零改动、底层已是新 store。

## 4. 必须守住的 7 条红线(拆完逐条验)

1. `activeControllers` 永远是模块单例、**不是 atom**;`finally` 里只删"还是自己注册的那个 controller"(`get(sessionId) === controller`),避免被顶掉的旧 run 清掉新 run。
2. `signal` 穿透到 model adapter 和每个 await;`wait()` abort 时 reject `DOMException(_, 'AbortError')`。
3. model adapter **除 AbortError 外永不抛**(契约在 model 层);loop 的 catch 只分 `stopped`(isAbortError)/ `error`(中文消息)两支,别给 `runAgentTurn`/`generateFinalAnswer` 套会抛的 wrapper。
4. 所有 atom 都是 `Record<sessionId, _>`;运行时写入针对 **run 自己的 sessionId**(可能 ≠ activeSessionId,因为用户可能切了会话);"从 atom 取"不能塌缩成单一"当前会话"值。
5. 每个 await 后写回前都要 `sessionExists(sessionId)` + `isCurrentRun(sessionId,runId)`(RF2/MF6)——出现位置:resolveAgentTurn 后、streamAssistantAnswer 后、catch 块内、browser_action 内,一处不漏。
6. 工具懒清单:模型只看 `listToolSummaries`(name/description/runtime)+ `request_tool_schema`;完整 inputSchema 仅经 `ensureToolLoaded` 按需加载,记在 `run.loadedTools`,只有 `modelVisibleTools` 里的 schema 才发给下一轮;别预加载。
7. `historyEndIndex`(§0 run 边界)在 append 当前用户消息**之前**捕获、存进 run 记录,resume(continueAgentRunWithAnswers)原样复用,传给 buildConversationContext 不变;conversationContext **只在 `turnIndex===0`** 注入;summary 压缩 **fire-and-forget(void,不 await)**,仅在 run 真正 `done` 后触发,waiting_user/stopped/error/abort 路径都不跑。

## 5. 建议落地顺序(自下而上,每层先编译过再上一层)

1. **状态层**:coreState → coreHelpers → transientState → sessionLifecycle → persistenceDriver → persistence;旧 atoms.ts 改 re-export 桥。
2. **L0**:toolFormatters、payloadNormalizers(纯函数,零依赖,最先)。
3. **L1**:abortRegistry、runCtx。
4. **L2**:guards。
5. **L3**:timeline、askUserQuestion、answerStreaming、toolLoading。
6. **L4**:toolExecution。
7. **L5**:modelToolLoop。
8. **L6**:pipeline。
9. **L7**:runLifecycle、index;最后把 UI/测试 import 切到 `@/agentNew/runtime`。
10. **验收**:旧 `loop.test.ts` / `conversation-memory-loop.test.ts` / `browser-action-tool.test.ts` 等**不改**,跑通后再删旧树。

## 6. 本轮范围内的风险

- **测试可测性**:旧运行时靠传 `store` 让测试注入新 store(`renderWithStore`,`fileParallelism:false`)。直读 agentStore 单例会让运行时无法对全新 store 测试。**对策**:coreState 留一个 `getStore()` 间接层(默认返回 agentStore,测试可换),helper 内部走 `getStore()` 而非硬引 `agentStore`——这是对"无参"规则的小让步,换来可测性。
- **persistence 纳入本轮**:快照形状变了要兼容旧 localStorage 数据;`normalizeRunStatus` 等容错路径要原样保留,别在重构里把"宽松恢复"改严。
- **一个 store 的桥**:迁移期任何代码若还从别处 `createStore()`,状态立刻裂成两份——确保全树只有 coreState 一处建 store。
- **模型/工具循环行为等价**:resolveAgentTurn 有 5 个决策分支 + 4 处近似重复的 "answers 已提供" 守卫,重排时极易漏一处。要么逐字搬、要么把守卫抽成 askUserQuestion 里一个 helper(行为保持)——二选一,别半搬。
- **debugger**:旧 startAgentRun 第 82 行有遗留 `debugger`,搬运时删掉。

## 7. 还可顺手决定(非阻塞)

- ask_user_question 的"answers 已提供"守卫:**逐字搬** vs **抽成一个 helper 去重**(行为保持)。
- 目录形状已按 `coreState.ts`(根)+ `runtime/` + `state/` 落,如需全嵌套可再调。
