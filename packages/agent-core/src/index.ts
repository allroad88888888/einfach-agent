// `@web-agent/core` 根 barrel —— 发包白名单第 1 条 `.` 的实体（卡 S5a）。
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
//   · 本 barrel **不新增**任何 `@tauri-apps` 静态边。D3 已把 `runtime/workspaceDialog` 的插件加载
//     收进 `pickWorkspaceDirectory()` 的 Tauri 守卫之后，因此它可安全作为宿主 API 收进根面；冒烟
//     `index.smoke.test.ts` 断言 root import 本身不会加载 `@tauri-apps/plugin-dialog`。
//   · 既有事实（不是本卡引入的）：`./runtime/commands` 的静态图本来就经 `modelRun → runToolLoop`
//     摸到 `@tauri-apps/api/core`（11 个 `runtime/workspace*`、`shellCommand`、`modelTurnPrefix`）。
//     命令面是宿主 API 的主体、且全是同步函数，无法照 `state/stateViewPort` 那样延迟获取；这条边归
//     运行时自身，barrel 只是不把它变得更糟。守门的冒烟见 `index.smoke.test.ts`。
//
// 排除清单（都有正式去处，不在 `.` 里重复开一条通路）：
//   · 插件作者契约            → `./plugin`（`packages/agent-core/src/plugin.ts` 自称唯一公开入口）。
//   · timeline 投影           → `./timeline`（renderer-neutral，`agent-react` 与 UI 共用）。
//   · 工具契约 / workspace 桥 → `./tools`；委派接缝 → `./subagents`；计划 → `./planning`；
//     Skills → `./skills`；持久化 driver 契约 → `./persistence`。六域 barrel 各归各。
//   · 观测（`observability/{port,trace,performanceDiagnostics,types,logReader,traceCacheTotals}`）
//     → `./observability`。A 类清单里那 3 条观测路径与 §4 第 7 行重叠，按「一条 subpath 只有一个
//     归属」取后者；`apps/web`/`apps/cli` 的观测装配走 `@web-agent/core/observability`。
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
  // apps/cli: bootstrap/event-renderer/plugins/runtime；apps/web: main.tsx、plugins/desktopProvider
  defaultCore,
  // apps/cli: runtime.ts；apps/web: main.tsx —— 三个装配槽由宿主在启动时注入
  configureDefaultProjectSkillsProvider,
  configureDefaultSkillsRegistry,
  configureDefaultDelegation,
} from './runtime/core/coreInstance'
export { buildProjectSkillsWorkspaceBridge } from './runtime/projectSkillsBridge'
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
  setWorkspaceRoot,
  // 会话
  newSession,
  selectSession,
  removeSession,
  renameSession,
  // 会话 atom 作用域：S7b（E7）为 <ActiveSessionProvider> 补的受限只读通路，不给 store 生命周期
  sessionAtomScope,
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
  // 撤销 / 重做（会话事务日志）：undoTurn 是 UI 默认粒度，*Entry 是开发者粒度
  undoTurn,
  redoTurn,
  undoEntry,
  redoEntry,
  // 卡片与项目 Skills
  discardArtifact,
  refreshProjectSkills,
  // 子 Agent 视图（apps/web: SubagentTreePanel、SubagentSkillGovernancePanel）
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
export { scanPlugins } from './plugins/pluginScanner' // apps/cli: plugins.ts；apps/web: plugins/desktopProvider
export type { PluginScanBridge, ScannedPlugin } from './plugins/pluginScanner'
export { loadScannedPlugins } from './plugins/pluginLoader' // 同上
export type {
  LoadedPlugin, // apps/web: plugins/types.ts
  PluginInstallHost, // apps/web: plugins/desktopProvider
  PluginLoaderDeps, // apps/cli: plugins.ts；apps/web: plugins/{desktopProvider,desktopImportModule}
  PluginLoadResult,
} from './plugins/pluginLoaderTypes'
export type { PluginApiVersionRange } from './plugins/manifestTypes' // apps/cli: plugins.ts；apps/web: plugins/desktopProvider

// ---------------------------------------------------------------------------
// 工作区目录选择与上下文预算（./runtime/workspaceDialog、./runtime/contextBudget）
// ---------------------------------------------------------------------------
export { canPickWorkspaceDirectory, pickWorkspaceDirectory } from './runtime/workspaceDialog'
export type { PickWorkspaceDirectoryResult } from './runtime/workspaceDialog'
export {
  // apps/web: ContextStats.tsx —— S7a 从 compactionPlugin 换出来的正式通路（E1 记债，§3.5）
  COST_SOFT_CAP_TOKENS,
  contextInputBudgetTokens,
} from './runtime/contextBudget'

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
  workspaceRenameStateAtom,
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
  completedPlanRecordExpandedAtom, // CompletedPlanRecord
  composerDraftAtom, // Composer
  contextStatsAtom, // ContextStats
  expandedPlanStagesAtom, // PlanPanel、CompletedPlanRecord
  expandedTranscriptGroupsAtom, // MessageList
  pendingArtifactsAtom, // SaveArtifact
  pendingQuestionAnswersAtom, // AskUserQuestionCard
  planPanelExpandedAtom, // PlanPanel
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
