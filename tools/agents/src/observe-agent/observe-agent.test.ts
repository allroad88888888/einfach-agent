import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@web-agent/core/tools'
import { observeAgentTool } from './observe-agent'

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    ...overrides,
  }
}

describe('observe_agent', () => {
  it('returns the delegation capability error when no runtime is injected', () => {
    const result = observeAgentTool.execute({ executionId: 'e1' }, makeCtx())

    expect(result).toEqual({
      ok: false,
      error: '子 Agent 委派能力不可用：当前运行环境未注入委派执行器。',
      code: 'AGENT_DELEGATION_UNAVAILABLE',
      retryable: false,
    })
  })

  it('trims the execution id and returns an observation', () => {
    const observeExecution = vi.fn(() => ({
      node: {
        id: 'e1',
        graphId: 'g',
        sessionId: 's',
        runId: 'r',
        dependsOn: [],
        type: 'agent' as const,
        status: 'running' as const,
        label: 'child',
        attempt: 1,
        generation: 1,
        effectKeys: [],
        createdAt: 1,
        updatedAt: 2,
      },
      children: [],
    }))

    const result = observeAgentTool.execute(
      { executionId: ' e1 ' },
      makeCtx({ observeExecution }),
    )

    expect(observeExecution).toHaveBeenCalledWith('e1')
    expect(result).toMatchObject({
      ok: true,
      data: { node: { id: 'e1', status: 'running' } },
    })
  })

  it('returns structured failures for invalid and unknown ids', () => {
    const observeExecution = vi.fn(() => ({ node: undefined, children: [] }))

    const invalid = observeAgentTool.execute(
      { executionId: '  ' },
      makeCtx({ observeExecution }),
    )
    const unknown = observeAgentTool.execute(
      { executionId: 'missing' },
      makeCtx({ observeExecution }),
    )

    expect(invalid).toMatchObject({
      ok: false,
      code: 'AGENT_INVALID_EXECUTION_ID',
    })
    expect(unknown).toMatchObject({
      ok: false,
      code: 'AGENT_EXECUTION_UNKNOWN',
    })
  })

  it('returns a retryable failure when the execution runtime throws', () => {
    const result = observeAgentTool.execute(
      { executionId: 'e1' },
      makeCtx({ observeExecution: vi.fn(() => { throw new Error('runtime unavailable') }) }),
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'AGENT_OBSERVE_FAILED',
      retryable: true,
      details: { executionId: 'e1' },
    })
  })
})
