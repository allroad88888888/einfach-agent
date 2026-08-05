// 会话瞬态状态的稳定公开入口。
// 原子定义、变更命令和只读查询按职责拆到相邻模块；保留此路径以兼容既有调用方。

export {
  alwaysAllowedToolsAtom,
  assistantStreamAtom,
  browserCardsAtom,
  completedPlanRecordExpandedAtom,
  composerDraftAtom,
  contextStatsAtom,
  expandedPlanStagesAtom,
  expandedTranscriptGroupsAtom,
  pendingArtifactsAtom,
  pendingQuestionAnswersAtom,
  planPanelExpandedAtom,
  queuedUserMessagesAtom,
  runtimeTranscriptEventsAtom,
  toolActivityAtom,
  transcriptInjectionFingerprintsAtom,
  withdrawnTurnNoticeAtom,
} from './sessionTransientAtoms'
export {
  addAlwaysAllowedTool,
  addBrowserCard,
  addPendingArtifact,
  addRuntimeTranscriptEvent,
  clearAssistantStream,
  clearPendingQuestionAnswers,
  clearQueuedUserMessages,
  enqueueUserMessage,
  patchTranscriptInjectionFingerprints,
  pruneBrowserCardsAfter,
  pruneRuntimeTranscriptEventsAfter,
  removePendingArtifact,
  removeToolActivity,
  setAssistantStream,
  setComposerDraft,
  setContextStats,
  setPendingQuestionAnswer,
  setWithdrawnTurnNotice,
  takeQueuedUserMessages,
  upsertToolActivity,
} from './sessionTransientMutations'
export {
  getPendingQuestionAnswers,
  getTranscriptInjectionFingerprints,
  isToolAlwaysAllowed,
} from './sessionTransientReaders'
export type {
  ContextCacheStats,
  ContextCacheTotals,
  ContextRoleStats,
  ContextStatsSnapshot,
  ContextUsageStats,
} from './contextStats'
export type {
  AssistantStreamState,
  AskUserAnswerValue,
  BrowserCard,
  PendingArtifact,
  QueuedUserMessage,
  RuntimeTranscriptEvent,
  RuntimeTranscriptEventKind,
  ToolActivity,
  TranscriptInjectionFingerprints,
  WithdrawnTurnNotice,
} from './sessionTransientPayloads'
