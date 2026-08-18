// 渲染层触发的会话瞬态写入 —— 收口成命令的那一层。
// ---------------------------------------------------------------------------
// 这些写入的共同点不是「都属于某张卡片」，而是**发起者是 UI、落点是会话 atom**：用户在卡片上
// 作答、丢弃产物、关掉一条提示，或者渲染层从观测库补算出一个 core 当时拿不到的数。
// 它们必须走命令，因为 UI 侧只持有 agent store 的**只读**通路（见 sessionScopeCommands.ts），
// 直接写会绕过收口点、不进事务日志。

import { activeSessionIdAtom, sessionsAtom } from '../../state/rootStore'
import {
  mergeContextStatsCacheTotals,
  removePendingArtifact,
  setPendingQuestionAnswer,
  setWithdrawnTurnNotice,
} from '../../state/transientAtoms'
import type { AskUserAnswerValue, ContextCacheTotals } from '../../state/transientAtoms'
import type { CoreInstance } from '../core/coreInstance'

/** Builds commands for UI surfaces that mutate transient conversation state. */
export function createCardCommands(core: CoreInstance) {
  function answerQuestion(questionId: string, value: AskUserAnswerValue): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id || !core.rootStore.getter(sessionsAtom)[id]) return
    setPendingQuestionAnswer(id, questionId, value, core)
    core.persistence.persistRecovery(id, 'ask_user_answer_recorded')
  }

  function discardArtifact(sessionId: string, artifactId: string): void {
    removePendingArtifact(sessionId, artifactId, core)
  }

  // 简介：关掉「已回退/已撤回」那条一次性提示。
  // 详情：提示由 planCommands 的 rollbackPlanStage 立起，只有用户能判断自己看见了没有，
  //   所以清除的时机在 Composer（改草稿 / 发送成功 / 输入框里按 Esc）。
  function dismissWithdrawnTurnNotice(): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    setWithdrawnTurnNotice(id, undefined, core)
  }

  // 简介：把渲染层从 trace 里补算出的「本次 run 累计缓存命中」并回上下文统计。
  // 详情：core 发请求时拿不到这个数（它要异步读观测库），只有 ContextStats 面板会在发现
  //   cacheTotals 落后于当前 run 时去补。stale guard 在写入器里，见 mergeContextStatsCacheTotals。
  function applyRecoveredCacheTotals(runId: string, cacheTotals: ContextCacheTotals): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    mergeContextStatsCacheTotals(id, runId, cacheTotals, core)
  }

  return { answerQuestion, applyRecoveredCacheTotals, discardArtifact, dismissWithdrawnTurnNotice }
}
