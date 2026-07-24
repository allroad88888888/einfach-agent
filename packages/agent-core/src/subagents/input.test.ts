import { describe, expect, it } from 'vitest'
import { normalizeDelegateAgentInput } from './input'

describe('normalizeDelegateAgentInput', () => {
  it('accepts children and fills bounded defaults', () => {
    const result = normalizeDelegateAgentInput({
      children: [
        { objective: ' inspect runtime ', mode: ' explore ', expectedOutput: ' notes ' },
      ],
    })

    expect(result).toMatchObject({
      ok: true,
      input: {
        children: [
          { objective: 'inspect runtime', mode: 'explore', expectedOutput: 'notes' },
        ],
        strategy: 'parallel_wait_all',
        maxDepth: 2,
        maxChildren: 6,
        maxConcurrent: 4,
        maxTotalNodes: 64,
        maxModelCalls: 128,
        toolProfile: 'delegate_only',
      },
    })
  })

  it('rejects empty batches and empty child objectives', () => {
    expect(normalizeDelegateAgentInput({ children: [] })).toEqual({
      ok: false,
      error: 'invalid delegate_agent: children must be a non-empty array',
    })
    expect(normalizeDelegateAgentInput({ children: [{ objective: ' ' }] })).toEqual({
      ok: false,
      error: 'invalid delegate_agent: every child objective must be a non-empty string',
    })
  })

  it('validates root and child tool profiles', () => {
    expect(normalizeDelegateAgentInput({
      toolProfile: 'workspace_read',
      children: [{ objective: 'read', toolProfile: 'delegate_only' }],
    })).toMatchObject({
      ok: true,
      input: {
        toolProfile: 'workspace_read',
        children: [{ objective: 'read', toolProfile: 'delegate_only' }],
      },
    })
    expect(normalizeDelegateAgentInput({ toolProfile: 'write_all', children: [{ objective: 'x' }] }))
      .toEqual({ ok: false, error: 'invalid delegate_agent: toolProfile must be delegate_only or workspace_read' })
    expect(normalizeDelegateAgentInput({ children: [{ objective: 'x', toolProfile: 'write_all' }] }))
      .toEqual({ ok: false, error: 'invalid delegate_agent: child toolProfile must be delegate_only or workspace_read' })
  })

  it('accepts only known dangerous tools in explicit confirmed capability requests', () => {
    expect(normalizeDelegateAgentInput({
      confirmedTools: ['write_file', 'write_file'],
      children: [{ objective: 'write', confirmedTools: ['write_file'] }],
    })).toMatchObject({
      ok: true,
      input: {
        confirmedTools: ['write_file'],
        children: [{ objective: 'write', confirmedTools: ['write_file'] }],
      },
    })
    expect(normalizeDelegateAgentInput({ confirmedTools: ['read_file'], children: [{ objective: 'x' }] }))
      .toEqual({ ok: false, error: 'invalid delegate_agent: confirmedTools must contain only dangerous tool names' })
    expect(normalizeDelegateAgentInput({ children: [{ objective: 'x', confirmedTools: ['unknown'] }] }))
      .toEqual({ ok: false, error: 'invalid delegate_agent: child confirmedTools must contain only dangerous tool names' })
  })

  it('clamps numeric budgets and respects maxChildren before scheduling', () => {
    const tooMany = normalizeDelegateAgentInput({
      maxChildren: 1,
      children: [{ objective: 'a' }, { objective: 'b' }],
    })
    expect(tooMany).toEqual({
      ok: false,
      error: 'invalid delegate_agent: children length 2 exceeds maxChildren 1',
    })

    const clamped = normalizeDelegateAgentInput({
      children: [{ objective: 'a', maxTurns: 999 }],
      strategy: 'parallel_best_effort',
      maxDepth: 999,
      maxChildren: 999,
      maxConcurrent: 999,
      maxTotalNodes: 999,
      maxModelCalls: 999,
    })
    expect(clamped).toMatchObject({
      ok: true,
      input: {
        strategy: 'parallel_best_effort',
        maxDepth: 6,
        maxChildren: 12,
        maxConcurrent: 8,
        maxTotalNodes: 256,
        maxModelCalls: 512,
        children: [{ objective: 'a', maxTurns: 16 }],
      },
    })
  })
})
