import { describe, expect, it } from 'vitest'

import { agentHistoryTargetSqlPredicate, decodeAgentHistoryTargetSqlRow } from './historyTargetSql'

describe('agent history target SQL mapping', () => {
  it('maps root identity to exact null-aware fields', () => {
    expect(agentHistoryTargetSqlPredicate({ kind: 'root', conversationId: 'conversation' }, 2)).toEqual({
      sql: 'target_kind=$2 AND conversation_id=$3 AND run_id IS NULL AND agent_path IS NULL',
      params: ['root', 'conversation'],
    })
    expect(decodeAgentHistoryTargetSqlRow({ target_kind: 'root', conversation_id: 'conversation',
      run_id: null, agent_path: null })).toEqual({ kind: 'root', conversationId: 'conversation' })
  })

  it('maps qualified child identity to all four fields', () => {
    const target = { kind: 'child', conversationId: 'conversation',
      runId: 'run', agentPath: '/root/research' } as const
    expect(agentHistoryTargetSqlPredicate(target, 4, 'c.')).toEqual({
      sql: 'c.target_kind=$4 AND c.conversation_id=$5 AND c.run_id=$6 AND c.agent_path=$7',
      params: ['child', 'conversation', 'run', '/root/research'],
    })
    expect(decodeAgentHistoryTargetSqlRow({ target_kind: 'child', conversation_id: 'conversation',
      run_id: 'run', agent_path: '/root/research' })).toEqual(target)
  })

  it('rejects inconsistent stored identity fields', () => {
    expect(() => decodeAgentHistoryTargetSqlRow({ target_kind: 'root', conversation_id: 'conversation',
      run_id: 'run', agent_path: null })).toThrow()
    expect(() => decodeAgentHistoryTargetSqlRow({ target_kind: 'child', conversation_id: 'conversation',
      run_id: null, agent_path: null })).toThrow()
  })
})
