// subagents/index.ts —— 委派接缝公开面 barrel（issue 卡 S2a，白名单 subpath `@einfach-agent/core/subagents`）。
// 只做 re-export，不改任何被引用文件的实现（同 S1a `tools/index.ts` 的做法）。
//
// 收进来的判据（本卡采用，逐条 grep 核对过真实消费方）：
//   一条导出进 barrel，当且仅当它的**签名只由委派协议的公开词汇构成**——`./types` 的协议类型、
//   agent path、档位表、工具档位、端口接口，加上早已公开的 `@einfach-agent/ai` 与 `state/core.type`。
//   只要签名里出现 `DelegateAgentRuntimeState` / `DelegationCallState` / `TreeRuntimeBudget` 这类
//   **core 子 run 的可变实现容器**，就判内部：把它们写进公开面等于把执行内核的内部结构一起冻成承诺。
//   另：同一文件里当前零外部消费方的导出不收——公开面按真实消费方划线，不做 `export *`。
//
// 归位说明（`runtime/`、`state/`、`execution/` 下的四条委派接缝为什么从这里出）：
//   盘点 §4 的白名单只有 9 条 subpath，没有 `./runtime`、`./state`、`./execution`，且第 5 行明确
//   把 `delegationContract`、`stateViewPort`、`execution/types` 算进 `./subagents` 的覆盖范围；
//   根 barrel `.` 会连着 `runtime/workspaceDialog` 拖进 Tauri dialog 依赖（盘点 §4 注），能力包不该
//   被迫走那条路径。因此这四条**源文件不搬家**（`delegationContract.ts` 留在 `runtime/`，core 主循环
//   与 toolContext 就近相对引用），只在这里 re-export：包外只认 barrel，包内继续走相对路径。
//
// 不收（判为内部；S2b 不改这几条消费方，见卡内记录）：
//   · ./childAgentLoop      —— `RunChildAgentInput` 13 个字段全是子 run 的内部调用帧
//                              （runtime/callModel/delegationState/budget/…），是执行循环本身。
//   · ./childModelClient    —— `createChildModelCaller(runtime: DelegateAgentRuntimeState)`、
//                              `ChildModelCaller(state: DelegationCallState, …)` 都绑在内部容器上；
//                              `firstAssistantText` 是 `ModelChatResponse` 的通用取文本工具，
//                              归属 agent-ai，与 E8 `concurrency` 同类（错位的通用原语）。
//   · ./delegationBatch     —— `createDelegateAgents(runtime: DelegateAgentRuntimeState)` 同上绑在
//                              内部容器上；唯一消费方是同目录的 `./delegationRuntime`（相对导入）。
//   · ./delegationPolicy    —— `resolveDelegationRequestPolicy(runtime: DelegateAgentRuntimeState, …)`
//                              入参出参都含内部状态（`DelegationCallState`、`TreeRuntimeBudget`）。
//   · ./runtimeState        —— `DelegateAgentRuntimeState` 是 core 子 run 的可变资源容器（registry、
//                              AbortController、缓存追踪、owners 引用计数）；`collectChangeSets` /
//                              `isAbortError` / `toErrorMessage` 是通用工具错位，同 E8 口径。
//   · ./concurrency         —— 已按盘点 E8 / 卡 S7b 处置：文件搬去 `runtime/concurrencyLimiter`
//                              （通用原语归通用层），本目录不再有这个文件，barrel 自然不必表态。
//   · ./childResult、./childToolVisibility、./prompt、./routing、./childAgentToolCalls 等
//                           —— 外部消费方为零，本就不在公开面。
//   · `getSubagentViewCommandFacade`（stateViewPort）—— core 内部 `runtime/commands/subagentViewCommands.ts`
//                              读取用，方向是 core→包，外部零消费方。
//   · `./tierRouting` 的 `applySubagentTier` / `subagentTierTarget` / `supportsSubagentTierRouting`、
//     `toolProfile` 的裁剪函数、`./modelSelection` 整个文件（`routeChildModel`、
//     `SubagentModelSelectionInput`、`createSubagentModelSelection`、`callSelectedSubagentModel`）、
//     `./delegationRuntimePorts` 的 `DelegateAgents` —— 子 run 内核自用，外部零消费方。
//     其中 `subagentTierTarget` / `supportsSubagentTierRouting` / `routeChildModel` /
//     `SubagentModelSelectionInput` / `DelegateAgents` 这五条曾随 S11d/S11e 的下沉短暂留在
//     barrel 里等复核：S11f 逐条 grep 复核确认消费方
//     只剩 core 内的相对导入（`delegationRuntime` / `modelSelection` / `delegationBatch` /
//     `childAgentLoop` / `childAgentToolCalls` / `runtimeState` 与同目录测试），且都不是任何
//     已导出签名的构成类型（`DelegationRuntime.delegateAgents`、`ToolContext.delegateAgents`
//     写的是内联方法签名，不引用 `DelegateAgents` 别名），故一并从公开面删除。
//   · `types.ts` 里 `SubagentToolProfile`、`SubagentModelTier`、`SubagentTaskCategory`、
//     `SubagentRiskLevel`、`SubagentSkillPromotion`、`SubagentSkillSource`、
//     `SubagentDangerousToolCapability`、`DelegateAgentRuntime`、`SubagentRuntimeTranscript`
//     —— 当前零外部具名消费方，需要时按上面的判据补，不预支公开承诺。

// ---------------------------------------------------------------------------
// 委派协议词汇（`./types`）
// ---------------------------------------------------------------------------
export type {
  // packages/subagents: archive/replay
  ChildAgentResult,
  // `DelegationRuntime.delegateAgents` 的返回类型（公开签名词汇）；具名消费方随 S11d 起在 core 内
  DelegateAgentBatchResult,
  DelegateAgentBatchStatus,
  // packages/subagents: archive/archiveIO（+ archiveCapacity/archiveIO 测试）；
  // 同时是 `DelegationRuntime.delegateAgents` 的入参类型
  DelegateAgentCallContext,
  // packages/subagents: archive/distill
  DelegateAgentChildSpec,
  DelegateAgentStrategy,
  // `DelegationRuntime.delegateAgents` 的入参类型（公开签名词汇）
  DelegateAgentInput,
  // packages/subagents: archive/replay、archive/archiveIO
  SubagentArchiveEvent,
  SubagentArchiveEventType,
  // packages/subagents: archive/archiveWriter
  SubagentArchiveWriteMode,
  // packages/subagents: schedulerState、archive/{replay,archiveIO,skillCache,archiveCapacity,distill}
  SubagentNodeRecord,
  // packages/subagents: state/subagentViewRecord、state/subagentViewTypes
  SubagentNodeStatus,
  // packages/subagents: schedulerState
  SubagentPath,
  // packages/subagents: archive/{archiveIO,skillCache,distill}
  SubagentSkillFile,
} from './types'

// ---------------------------------------------------------------------------
// agent path 寻址格式（`./path`）——归档、调度、树视图三方必须按同一格式解析
// ---------------------------------------------------------------------------
export {
  // packages/subagents: schedulerState、archive/archiveIO
  ROOT_AGENT_PATH,
  // packages/subagents: schedulerState、archive/archiveCapacity(.test)
  agentPathDepth,
  // packages/subagents: schedulerState
  childAgentPath,
  parentAgentPath,
  // packages/subagents: archive/replay
  compareAgentPaths,
  // packages/subagents: archive/replay、state/subagentExecutionTreeView、
  // state/subagentConversationTreeView
  parseAgentPath,
} from './path'

// ---------------------------------------------------------------------------
// 档位契约（`./tierRouting`）——Pro/Flash 抽象档位 → 具体 vendor+模型，装配层注入
// ---------------------------------------------------------------------------
export type {
  // packages/subagents: defaultTierRouting（默认表的类型）、runtime（端口注入口）
  SubagentTierRouting,
} from './tierRouting'

// ---------------------------------------------------------------------------
// 工具档位与输入归一化（`./toolProfile`、`./input`）——delegate_agent 工具的入参协议
// ---------------------------------------------------------------------------
export {
  // tools/agents: delegate-agent（工具 schema 的 enum，与其测试）
  SUBAGENT_TOOL_PROFILES,
} from './toolProfile'
export {
  // tools/agents: delegate-agent；packages/subagents: archive/archiveCapacity.test
  normalizeDelegateAgentInput,
} from './input'

// ---------------------------------------------------------------------------
// 注入端口（`./delegationRuntimePorts`）——装配层必须满足的六个端口（S11b 后：
// scheduler / archive / archiveFormat / skillDistill / lowCostExtractionSettings / tierRouting）
// ---------------------------------------------------------------------------
export type {
  // packages/subagents: archive/archiveIO 结构化实现（当前未具名 import，S2b 可具名化）
  SubagentArchivePort,
  // packages/subagents: runtime 结构化实现
  // （cacheBasePath/eventsPath/resultPath/formatParentTranscript）
  DelegationArchiveFormatPort,
  // packages/subagents: runtime 结构化实现（distill → archive/distill）
  SubagentSkillDistillPort,
  // packages/subagents: archive/distill 的入参出参形状契约（S11c/S11d 接线后由 core 调用）
  SubagentSkillDistillInput,
  SubagentSkillDistillResult,
  SkillDistillChatInput,
  // packages/subagents: runtime 按此形状构造端口对象，交给 `createDelegationRuntime`
  DelegationRuntimePorts,
} from './delegationRuntimePorts'

// ---------------------------------------------------------------------------
// 委派运行时工厂（`./delegationRuntime`）——签名只由协议词汇构成（per-run 输入 + 端口 →
// 公开运行时），执行装配本身留在 core，装配层只负责组端口
// ---------------------------------------------------------------------------
export {
  // packages/subagents: runtime（createDelegateAgentRuntime 的唯一实现）
  createDelegationRuntime,
} from './delegationRuntime'

// ---------------------------------------------------------------------------
// 委派能力契约（`../runtime/delegationContract`）——整个文件就是契约本身，全量 re-export；
// 它另外 re-export 的 4 个 `./types` 类型不在这里重复（已由上面的 `./types` 块给出）
// ---------------------------------------------------------------------------
export type {
  // packages/subagents: scheduler（对外再导出）、schedulerState
  ReserveChildrenInput,
  SubagentScheduler,
  // packages/subagents: runtime（createDelegateAgentRuntime 的入参与返回）
  DelegationRuntime,
  DelegationRuntimeInput,
  // 结构化消费：`DelegationRuntime` 的可选生命周期基接口
  DelegationRuntimeLifecycle,
  // packages/subagents: delegationAssembly（工厂返回值）
  DelegationCapability,
  DelegationRuntimeFactory,
} from '../runtime/delegationContract'

// ---------------------------------------------------------------------------
// 子 agent transcript 格式（`../runtime/subagentTranscript`）——core 子 run 与归档蒸馏
// 必须产出同一种文本格式，属格式契约
// ---------------------------------------------------------------------------
export {
  // packages/subagents: archive/distill
  compactSubagentTranscript,
  // packages/subagents: archive/distill、runtime
  formatSubagentTranscript,
} from '../runtime/subagentTranscript'

// ---------------------------------------------------------------------------
// 子 agent 视图端口（`../state/stateViewPort`）——包侧 state/atoms 与 core 的双向接缝
// ---------------------------------------------------------------------------
export {
  // packages/subagents: state/subagentViewAtoms、state/subagentArchiveReader、
  // state/subagentSkillGovernanceAtoms
  subagentStatePort,
  // packages/subagents: state/subagentCommandFacade
  registerSubagentViewCommandFacade,
} from '../state/stateViewPort'
export type {
  // packages/subagents: state/subagentCommandFacade 结构化实现（facade 的形状契约）
  SubagentViewCommandFacade,
  // packages/subagents: state/subagentArchiveReader（+ 三个 state 测试）
  ReadWorkspaceFileInput,
  ReadWorkspaceFileResult,
  ReadWorkspaceRunIndexPageInput,
  ReadWorkspaceRunIndexPageResult,
  WorkspaceRuntimeResult,
  // packages/subagents: state/subagentSkillGovernanceAtoms
  SkillGovernanceAction,
  SkillGovernanceOperation,
} from '../state/stateViewPort'

// ---------------------------------------------------------------------------
// 执行图投影类型（`../execution/types`）——子 agent 树视图按执行图快照渲染；
// 值侧的 `executionGraphAtom` 已由上面的 `subagentStatePort` 提供，这里只补类型
// ---------------------------------------------------------------------------
export type {
  // packages/subagents: state/subagentExecutionTreeView
  ExecutionGraphSnapshot,
  ExecutionNode,
  ExecutionNodeStatus,
} from '../execution/types'
