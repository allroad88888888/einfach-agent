// Ask-user 回答写入后的显式 recovery 边界。

import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '../../state/core.type'
import { createMemoryRecoveryDriver } from '../../state/persistence/recoveryDriver'
import { activeSessionIdAtom, sessionsAtom } from '../../state/rootStore'
import { getPendingQuestionAnswers } from '../../state/transientAtoms'
import { createCoreInstance } from '../core/coreInstance'
import { createCardCommands } from './cardCommands'

const SESSION_ID = 'recovery-answer-session'

describe('cardCommands recovery boundary', () => {
  it('captures every recorded ask-user answer for the active registered session', async () => {
    const core = createCoreInstance()
    const session: SessionMeta = {
      id: SESSION_ID,
      title: 'Ask user',
      settings: { vendor: 'deepseek', model: 'test-model' },
      createdAt: 1,
      updatedAt: 1,
    }
    core.rootStore.setter(sessionsAtom, { [SESSION_ID]: session })
    core.rootStore.setter(activeSessionIdAtom, SESSION_ID)
    const recovery = createMemoryRecoveryDriver()
    core.persistence.configure({
      recovery,
      recoveryStore: (id) => id === SESSION_ID ? core.getSessionStore(id).store : undefined,
    })

    createCardCommands(core).answerQuestion('question-1', ['first', 'second'])
    await core.persistence.flushRecovery()

    expect(getPendingQuestionAnswers(SESSION_ID, core)).toEqual({ 'question-1': ['first', 'second'] })
    await expect(recovery.loadLatest(SESSION_ID)).resolves.toMatchObject({
      values: { pendingQuestionAnswers: { 'question-1': ['first', 'second'] } },
    })
  })
})
