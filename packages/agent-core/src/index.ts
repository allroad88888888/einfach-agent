// `@einfach-agent/core` 根 barrel —— 发包白名单第 1 条 `.` 的实体（卡 S5a）。
// 判据见 docs/core-public-surface-audit.md §3.1 A 类「宿主装配 API」与 §4 白名单方案第 1 行。
//
// 定位：**宿主装配面**。消费方只有 `apps/web` 与 `apps/cli` 这两个把 Agent 装起来跑的宿主
//   ——建实例、接持久化/观测/委派、装插件、发命令、读 UI 只读 atom。工具域与能力包**不走这条**，
//   它们各自走 `./tools`、`./subagents`、`./persistence`、`./observability`、`./skills`、`./planning`。
//   本文件只做 re-export，不含任何实现（同 S1a `tools/index.ts`、S2a `subagents/index.ts` 的做法）。
//
// 收进来的判据（逐条 grep 核实真实消费方后决定，不做 `export *`）：
//   1. 有**非测试**消费方在 `apps/web` / `apps/cli` 里真实用到；或
//   2. 它是上面某个已导出值的参数/返回类型——这种类型早已被那个值结构性承诺，单独藏起来只会
//      让宿主没法给变量写类型（`CoreInstance`、`RuntimeConfig`、`PersistenceDependencies`、
//      `PickWorkspaceDirectoryResult` 三条走的是这一条）。
//   零消费方的导出一律不收：公开面按真实用量划线，不预支承诺（同 S2a）。
//
// atoms 的红线（CLAUDE.md「UI 只允许读取 atom、调用 commands」）：
//   **只收读面 atom 与它们的载荷类型，一个 writer 都不收。** `state/sessionWriters` 是 D 类测试
//   脚手架（盘点 §3.4），`state/transientAtoms` 里那 19 个 mutation（`setAssistantStream`、
//   `addBrowserCard`…）与 3 个 reader（`getPendingQuestionAnswers`…）同理——实测产品代码里
//   零消费方，只出现在测试里，正是红线生效的证据。改状态请走 `configureCommands` 以下的命令面。
//
// 模块图纪律（S2c 3911c9d 的教训：barrel 的静态导链会在 `vi.mock` 生效前把重实现灌进模块图）：
//   · 本 barrel **不新增**任何宿主上游包的静态边。T1（桌面端退出）之后 core 一个宿主上游包都不
//     认识：本机能力一律经 `runtime/hostBridge.ts` 收下的 loader 拿，桥背后是什么由装配层决定。
//     所以这条纪律今天没有具体的被测对象，但它管的是**将来**——真要再引一个上游包时，静态边
//     会连同这段说明一起回到审查视野。
//
// 排除清单（都有正式去处，不在 `.` 里重复开一条通路）：
//   · 插件作者契约            → `./plugin`（`packages/agent-core/src/plugin.ts` 自称唯一公开入口）。
//   · timeline 投影           → `./timeline`（renderer-neutral，`agent-react` 与 UI 共用）。
//   · 工具契约 / workspace 桥 → `./tools`；委派接缝 → `./subagents`；计划 → `./planning`；
//     Skills → `./skills`；持久化 driver 契约 → `./persistence`。六域 barrel 各归各。
//   · 观测（`observability/{port,trace,performanceDiagnostics,types,logReader,traceCacheTotals}`）
//     → `./observability`。A 类清单里那 3 条观测路径与 §4 第 7 行重叠，按「一条 subpath 只有一个
//     归属」取后者；`apps/web`/`apps/cli` 的观测装配走 `@einfach-agent/core/observability`。
//   · `tools/registry` 的 `toolRegistry` 单例 —— 盘点 §3.1 点名的**重复通路**：它就是
//     `defaultCore.tools`（tools/registry.ts:17）。白名单只留一条，宿主改用 `defaultCore.tools`。
//   · `skills/projectSkillPreferences` —— 归 `./skills`，且是另一条工作线在途的模块（S4 卡同款警戒），
//     本卡不表态。
//   · core 内部实现（`state/sessionWriters`、`state/sessionStore`、`runtime/core/pluginHost`、
//     `runtime/core/plugins/*`、`state/persistence/hydrate` …）—— D/E 类，本就不该有公开面。
//   · `resetRootStore`、`createCoreInstance`、`createCommands`/`CommandApi`、`contextCheckpointAtom`
//     等 —— 仅测试在用或零消费方；建隔离实例的正式通路是 `./plugin` 的 `createCore()`。

// ---------------------------------------------------------------------------
// 运行时实例与装配槽（./runtime/core/coreInstance）
// ---------------------------------------------------------------------------
export {
  // apps/cli: bootstrap/event-renderer/plugins/runtime；apps/web: main.tsx、plugins/workspacePluginProvider
  defaultCore,
  // apps/cli: runtime.ts；apps/web: main.tsx —— 三个装配槽由宿主在启动时注入
  configureDefaultProjectSkillsProvider,
  configureDefaultSkillsRegistry,
  configureDefaultDelegation,
} from './runtime/core/coreInstance'
export { buildProjectSkillsWorkspaceBridge } from './runtime/projectSkillsBridge'
// tools-skills 的 provider：扫用户目录前先问宿主要主目录（宿主给不出时返回 undefined）
export { resolveUserSkillsRoot } from './runtime/userSkillsRoot'
export type {
  // defaultCore 的类型
  CoreInstance,
  // configureCommands 的参数类型
  RuntimeConfig,
  // 宿主提供的项目 Skills 读盘桥：apps/cli 的 workspace-files.ts 就照它实现
  ProjectSkillsLoaderBridge,
  // configureDefaultProjectSkillsProvider 的参数类型
  ProjectSkillsProvider,
} from './runtime/core/coreInstance'
// 主 Agent 换模型升档的策略槽（RuntimeConfig.modelEscalation 的类型）——判据与子 Agent 共用，
// 换不换、换成什么由装配层决定；不接就不升档。
export type { ModelEscalationPolicy, ModelEscalationRequest } from './runtime/modelEscalation'

// ---------------------------------------------------------------------------
// 宿主能力桥（./runtime/hostBridge）—— 与上一组同类：宿主在启动时注入的装配槽
// ---------------------------------------------------------------------------
// 归在装配槽这一组而不是另起门类：`configureHostInvoke` 与上面三个 `configureDefault*` 是同一种
// 东西 —— core 留一个洞，宿主在启动时把自己的实现填进去。区别只是它住在 `runtime/hostBridge`
// 而非 `runtime/core/coreInstance`（两者都是模块级单例），所以单开一段标题。
//
// 与「零消费方一律不收」的取舍：本卡（H1）交付时 `apps/web` / `apps/cli` 里还没有调用点，注入
// 发生在 H5（桌面）与 B 线（浏览器：HTTP invoke）。
// 收进来是因为**可达性本身就是这条契约的内容** —— 装配层 import 不到的注入点等于没有注入点。
// 交付的形态是 `configureHostInvoke({ loader, platform })`，loader 由装配层自己持有
// （apps/web/src/host/hostCommandBridge.ts、apps/cli/src/runtime.ts）——core 侧不提供任何具体
// 宿主的 loader，否则装配层就得深导入一个 `runtime/host*` 子路径，撞下面这条白名单本身。
//
// 只收两个：`hasHostBridge` / `loadHostInvoke` 的消费方全在 core 内部（H2–H4 要改的那 13 个
// runtime 模块），宿主不该也不需要自己去解析桥，按同一条「按真实用量划线」的规矩留在包内。
export { configureHostInvoke } from './runtime/hostBridge'
// 宿主实现自己的桥时要照它写签名（packages/host-node 的路由表、浏览器侧的 HTTP invoke）
export type { HostInvoke, HostBridgeRegistration } from './runtime/hostBridge'
export { readWorkspaceImage } from './runtime/workspaceImageRead'
export type { WorkspaceImageMimeType, WorkspaceImageReadInput, WorkspaceImageReadResult } from './runtime/workspaceImageRead'
export type { ViewImageCapability, ViewImageCapabilityContext, ViewImageInput, ViewImageResult } from './tools/types'
// S5：登记桥时必须一并声明宿主平台。**同机宿主**（CLI：解释器与被执行的命令同一台机器）用这个
// 函数取值；远端宿主（浏览器 → Node server）必须从握手拿，用本地探测会稳定答错整整一个平台。
// 读取面不在这里：两个消费者（shell 桥、注入模型的「运行环境」段）读的是 `@einfach-agent/core/tools`
// 的 `hostPlatform()`，宿主不需要也不该自己去读那个值。
export { detectLocalPlatform } from './runtime/hostPlatform'
export type { HostPlatform } from './runtime/hostPlatform'

// ---------------------------------------------------------------------------
// 命令面（./runtime/commands）—— UI 唯一被允许的变更入口
// ---------------------------------------------------------------------------
export {
  // apps/web: main.tsx、settings/*、mcp/initialize；apps/cli: bootstrap/runtime
  configureCommands,
  // 工作区
  newWorkspace,
  selectWorkspace,
  toggleWorkspaceExpanded,
  toggleWorkspaceSettings,
  renameWorkspace,
  removeWorkspace,
  setWorkspaceRoot,
  // 会话
  newSession,
  selectSession,
  removeSession,
  renameSession,
  setActiveSessionModelSettings,
  // 会话 atom 作用域：S7b（E7）为 <ActiveSessionProvider> 补的受限只读通路，不给 store 生命周期
  sessionAtomScope,
  sessionUndoAvailabilityAtom,
  // run 生命周期
  sendMessage,
  continueInterruptedRun,
  getSessionRecoveryStatus,
  listSessionRecoveryStatuses,
  continueRecoveredSession,
  stopRun,
  setApprovalMode,
  resumeWithAnswers,
  confirmTool,
  answerQuestion,
  // 计划
  approvePlan,
  continuePlan,
  rollbackPlanStage,
  // 对话撤回 / 撤销 / 重做（会话事务日志）：retractTurn 是用户消息入口，*Entry 是开发者粒度
  retractTurn,
  undoTurn,
  redoTurn,
  undoEntry,
  redoEntry,
  // 卡片与项目 Skills
  applyRecoveredCacheTotals,
  discardArtifact,
  dismissWithdrawnTurnNotice,
  refreshProjectSkills,
  // 子 Agent 视图（全局 run 归档 / skill 治理弹窗；两块面板随 A3 退场，apps/web 目前没有 UI
  // 消费者——状态与命令面仍在 packages/subagents 的 subagentViewAtoms / subagentArchiveAtoms /
  // subagentSkillGovernanceAtoms 等文件里，由那边的测试与 stateViewPort.ts 的
  // SubagentViewCommandFacade 继续练到）
  selectSubagentNode,
  selectGlobalSubagentRun,
  loadGlobalSubagentRuns,
  loadSubagentArchive,
  loadSubagentArchivePreview,
  loadSubagentTrace,
  setCandidateSkillFilter,
  selectCandidateSkill,
  loadCandidateSkills,
  openSkillGovernanceDialog,
  closeSkillGovernanceDialog,
  confirmSkillGovernance,
} from './runtime/commands'
export type {
  // apps/web: modelInput/prepareProviderUserInput.ts
  UserInputPreparer,
  ContinueRecoveredSessionResult,
  SessionRecoveryStatus,
  HistoryCommandRefusal,
  HistoryCommandResult,
  SetActiveSessionModelSettingsResult,
} from './runtime/commands'

// ---------------------------------------------------------------------------
// 运行时事件订阅（./runtime/core/events）—— 无 UI 宿主的渲染入口
// ---------------------------------------------------------------------------
export { subscribeAgentEvents } from './runtime/core/events' // apps/cli: bootstrap、event-renderer
export type { AgentEvent } from './runtime/core/events' // apps/cli: event-renderer

// ---------------------------------------------------------------------------
// 持久化装配（./runtime/persistenceBridge）—— driver 实现由 persistence-* 包提供
// ---------------------------------------------------------------------------
export {
  configurePersistence, // apps/cli: runtime.ts；apps/web: main.tsx
  hydratePersistence, // apps/web: main.tsx（E4 换掉 state/persistence/hydrate 后的正式通路）
} from './runtime/persistenceBridge'
export type { PersistenceDependencies } from './runtime/persistenceBridge' // configurePersistence 的参数类型

// ---------------------------------------------------------------------------
// 插件加载面（./plugins/*）—— P 线宿主装配 API，盘点成文时尚不存在，按 §4 第 1 行归 `.`
// ---------------------------------------------------------------------------
export { scanPlugins } from './plugins/pluginScanner' // apps/cli: plugins.ts；apps/web: plugins/workspacePluginProvider
export type { PluginScanBridge, ScannedPlugin } from './plugins/pluginScanner'
export { loadScannedPlugins } from './plugins/pluginLoader' // 同上
export type {
  LoadedPlugin, // apps/web: plugins/types.ts
  PluginInstallHost, // apps/web: plugins/workspacePluginProvider
  PluginLoaderDeps, // apps/cli: plugins.ts；apps/web: plugins/{workspacePluginProvider,pluginImportModule}
  PluginLoadResult,
} from './plugins/pluginLoaderTypes'
export type { PluginApiVersionRange } from './plugins/manifestTypes' // apps/cli: plugins.ts；apps/web: plugins/workspacePluginProvider

// ---------------------------------------------------------------------------
// 上下文预算（./runtime/contextBudget）
// ---------------------------------------------------------------------------
// 工作区目录选择也走已登记的宿主桥：Node 宿主负责打开操作系统选择器，core 只认结果。
export {
  // apps/web: ContextStats.tsx —— S7a 从当年的上下文压缩插件换出来的正式通路（E1 记债，§3.5；
  // 该插件已随 A1 删除）
  COST_SOFT_CAP_TOKENS,
  contextInputBudgetTokens,
} from './runtime/contextBudget'
export {
  canPickWorkspaceDirectory,
  pickWorkspaceDirectory,
} from './runtime/workspaceDirectoryPicker'
export type { PickWorkspaceDirectoryResult } from './runtime/workspaceDirectoryPicker'

// ---------------------------------------------------------------------------
// 跨会话数据类型（./state/core.type）—— S3b 点名的 SessionMeta/WorkspaceMeta 在此
// ---------------------------------------------------------------------------
export type {
  // apps/web: MessageList/messageTimelineViewModel 等；persistence-idb、persistence-sqlite
  ConversationItem,
  // apps/web: RunDurationStatus；packages/subagents: runtime.ts
  RunState,
  // apps/cli: bootstrap；persistence-idb、persistence-sqlite
  SessionMeta,
  WorkspaceMeta,
  // apps/web: modelInput/kimiRegionSetting、settings/startupCredentialTarget
  ModelSettings,
} from './state/core.type'

// ---------------------------------------------------------------------------
// 顶层只读 atom（./state/rootStore → 定义在 ./state/rootAtoms）
// ---------------------------------------------------------------------------
export {
  // 全局唯一根 store：apps/web 的 <Provider> 与命令绑定都要它（17 个非测试消费方）
  rootStore,
  // 工作区
  workspacesAtom,
  activeWorkspaceIdAtom,
  activeWorkspaceMetaAtom,
  activeWorkspaceRootAtom,
  expandedWorkspaceIdsAtom,
  workspaceSettingsOpenIdsAtom,
  // 项目 Skills 快照与禁用清单（读面；写走 refreshProjectSkills / settings 命令）
  projectSkillsAtom,
  disabledProjectSkillsByWorkspaceAtom,
  // 会话列表
  sessionsAtom,
  activeSessionIdAtom,
  activeSessionMetaAtom,
} from './state/rootStore'

// ---------------------------------------------------------------------------
// 会话内只读 atom（./state/sessionAtoms）—— 取值范围由 sessionAtomScope 绑定的 store 决定
// ---------------------------------------------------------------------------
export {
  itemsAtom, // MessageList、Composer、HistoryImageCompatibilityGuard…
  runAtom,
  planAtom,
  planStageCheckpointsAtom, // apps/web: CompletedPlanRecord
} from './state/sessionAtoms'

// ---------------------------------------------------------------------------
// 会话瞬态只读 atom 与载荷类型（./state/transientAtoms）—— 一个 mutation 都不收，见头部红线
// ---------------------------------------------------------------------------
export {
  assistantStreamAtom, // MessageList、Composer、ToolActivity
  browserCardsAtom, // BrowserActionCard
  contextStatsAtom, // ContextStats
  pendingArtifactsAtom, // SaveArtifact
  pendingQuestionAnswersAtom, // AskUserQuestionCard
  queuedUserMessagesAtom, // Composer
  runtimeTranscriptEventsAtom, // MessageList
  toolActivityAtom, // ToolActivity
  withdrawnTurnNoticeAtom, // Composer
} from './state/transientAtoms'
export type {
  AskUserAnswerValue, // AskUserQuestionCard（./runtime/askUserQuestion 也 re-export 它，公开面只留这一条）
  BrowserCard, // BrowserActionCard、messageTimelineViewModel
  ContextStatsSnapshot, // ContextStats
  PendingArtifact, // SaveArtifact
  ToolActivity, // AppShell、ToolActivity
} from './state/transientAtoms'

// ---------------------------------------------------------------------------
// 工作区派生（./state/workspaceState）与执行图只读 atom（./execution/graph）
// ---------------------------------------------------------------------------
export { resolveSessionWorkspaceRoot } from './state/workspaceState' // apps/web: ProjectSkillsPanel、plugins/initialize
export {
  executionGraphAtom, // apps/web: PlanPanel
  activeExecutionNodeIdsAtom, // apps/web: PlanPanel
} from './execution/graph'
