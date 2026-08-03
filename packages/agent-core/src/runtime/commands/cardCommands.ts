import { activeSessionIdAtom } from '../../state/rootStore'
import { removePendingArtifact, setPendingQuestionAnswer } from '../../state/transientAtoms'
import type { AskUserAnswerValue } from '../../state/transientAtoms'
import type { CoreInstance } from '../core/coreInstance'

/** Builds commands for browser cards that mutate transient conversation state. */
export function createCardCommands(core: CoreInstance) {
  function answerQuestion(questionId: string, value: AskUserAnswerValue): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (id) setPendingQuestionAnswer(id, questionId, value, core)
  }

  function discardArtifact(sessionId: string, artifactId: string): void {
    removePendingArtifact(sessionId, artifactId, core)
  }

  return { answerQuestion, discardArtifact }
}
