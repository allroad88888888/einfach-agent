import { describe, expect, it } from 'vitest'
import {
  SUBAGENT_MODEL_TIERS,
  SUBAGENT_RISK_LEVELS,
  SUBAGENT_TASK_CATEGORIES,
} from './types'
import { SUBAGENT_TOOL_PROFILES } from './toolProfile'
import { DELEGATABLE_DANGEROUS_TOOLS } from '../runtime/dangerousTools'
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

  it('accepts only explicit Pro/Flash child model tiers', () => {
    expect(normalizeDelegateAgentInput({
      children: [
        { objective: 'simple lookup', modelTier: 'flash' },
        { objective: 'architecture review', modelTier: 'pro' },
        { objective: 'conservative default' },
      ],
    })).toMatchObject({
      ok: true,
      input: {
        children: [
          { objective: 'simple lookup', modelTier: 'flash' },
          { objective: 'architecture review', modelTier: 'pro' },
          { objective: 'conservative default' },
        ],
      },
    })

    expect(normalizeDelegateAgentInput({
      children: [{ objective: 'unknown tier', modelTier: 'auto' }],
    })).toEqual({
      ok: false,
      error: 'invalid delegate_agent: child modelTier must be one of pro, flash',
    })
  })

  it('accepts every value from each readonly delegation capability collection', () => {
    for (const modelTier of SUBAGENT_MODEL_TIERS) {
      expect(normalizeDelegateAgentInput({ children: [{ objective: 'x', modelTier }] })).toMatchObject({ ok: true })
    }
    for (const taskCategory of SUBAGENT_TASK_CATEGORIES) {
      expect(normalizeDelegateAgentInput({ children: [{ objective: 'x', taskCategory }] })).toMatchObject({ ok: true })
    }
    for (const riskLevel of SUBAGENT_RISK_LEVELS) {
      expect(normalizeDelegateAgentInput({ children: [{ objective: 'x', riskLevel }] })).toMatchObject({ ok: true })
    }
    for (const toolProfile of SUBAGENT_TOOL_PROFILES) {
      expect(normalizeDelegateAgentInput({ children: [{ objective: 'x', toolProfile }] })).toMatchObject({ ok: true })
    }
    expect(normalizeDelegateAgentInput({
      children: [{ objective: 'x', confirmedTools: DELEGATABLE_DANGEROUS_TOOLS }],
      confirmedTools: DELEGATABLE_DANGEROUS_TOOLS,
    })).toMatchObject({
      ok: true,
      input: {
        children: [{ confirmedTools: DELEGATABLE_DANGEROUS_TOOLS }],
        confirmedTools: DELEGATABLE_DANGEROUS_TOOLS,
      },
    })
  })

  it('normalizes observable routing features and rejects malformed values', () => {
    expect(normalizeDelegateAgentInput({
      children: [{
        objective: 'extract facts',
        taskCategory: 'extraction',
        riskLevel: 'low',
        crossModule: false,
        requiresTemporalNormalization: true,
        finalAcceptance: false,
        priorFailureCount: 2,
      }],
    })).toMatchObject({
      ok: true,
      input: {
        children: [{
          objective: 'extract facts',
          taskCategory: 'extraction',
          riskLevel: 'low',
          crossModule: false,
          requiresTemporalNormalization: true,
          finalAcceptance: false,
          priorFailureCount: 2,
        }],
      },
    })

    expect(normalizeDelegateAgentInput({
      children: [{ objective: 'x', taskCategory: 'guessing' }],
    })).toMatchObject({ ok: false })
    expect(normalizeDelegateAgentInput({
      children: [{ objective: 'x', riskLevel: 'critical' }],
    })).toMatchObject({ ok: false })
    expect(normalizeDelegateAgentInput({
      children: [{ objective: 'x', finalAcceptance: 'yes' }],
    })).toMatchObject({ ok: false })
    expect(normalizeDelegateAgentInput({
      children: [{ objective: 'x', requiresTemporalNormalization: 'yes' }],
    })).toEqual({
      ok: false,
      error: 'invalid delegate_agent: child requiresTemporalNormalization must be boolean',
    })
    expect(normalizeDelegateAgentInput({
      children: [{ objective: 'x', priorFailureCount: -1 }],
    })).toMatchObject({ ok: false })
  })

  it('preserves omission of optional routing features for backward compatibility', () => {
    const result = normalizeDelegateAgentInput({
      children: [{ objective: 'legacy child' }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.children[0]).not.toHaveProperty('requiresTemporalNormalization')
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
    expect(normalizeDelegateAgentInput({
      toolProfile: 'workspace_verify',
      children: [{ objective: 'verify', toolProfile: 'workspace_read' }],
    })).toMatchObject({
      ok: true,
      input: {
        toolProfile: 'workspace_verify',
        children: [{ objective: 'verify', toolProfile: 'workspace_read' }],
      },
    })
    expect(normalizeDelegateAgentInput({ toolProfile: 'write_all', children: [{ objective: 'x' }] }))
      .toEqual({
        ok: false,
        error: 'invalid delegate_agent: toolProfile must be one of delegate_only, workspace_read, workspace_verify',
      })
    expect(normalizeDelegateAgentInput({ children: [{ objective: 'x', toolProfile: 'write_all' }] }))
      .toEqual({
        ok: false,
        error: 'invalid delegate_agent: child toolProfile must be one of delegate_only, workspace_read, workspace_verify',
      })
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
    expect(normalizeDelegateAgentInput({
      confirmedTools: ['mcp__playwright__browser_navigate'],
      children: [{ objective: 'browse' }],
    })).toEqual({
      ok: false,
      error: 'invalid delegate_agent: confirmedTools must contain only dangerous tool names',
    })
    expect(normalizeDelegateAgentInput({
      children: [{
        objective: 'browse',
        confirmedTools: ['mcp__playwright__browser_navigate'],
      }],
    })).toEqual({
      ok: false,
      error: 'invalid delegate_agent: child confirmedTools must contain only dangerous tool names',
    })
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
