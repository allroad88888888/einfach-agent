import { activeSessionIdAtom, sessionsAtom } from '../../state/rootStore'
import {
  removePendingArtifact,
  setComposerDraft as writeComposerDraft,
  setPendingQuestionAnswer,
} from '../../state/transientAtoms'
import type { AskUserAnswerValue } from '../../state/transientAtoms'
import type { CoreInstance } from '../core/coreInstance'

/** Builds commands for browser cards that mutate transient conversation state. */
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

  // 简介：写当前会话的输入框草稿。
  // 详情：UI 以前直接 `useSetAtom(composerDraftAtom)`，绕过了「会话 atom 写入必须收口」——
  //   而门禁当时只扫 core，看不见渲染层。开这条命令是为了让 UI 有一条正当通路。
  //   草稿刻意不记账（逐击键会填满 undo 的 cap），理由见 state/sessionTransientMutations.ts。
  function setComposerDraft(draft: string): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    writeComposerDraft(id, draft, core)
  }

  return { answerQuestion, discardArtifact, setComposerDraft }
}
