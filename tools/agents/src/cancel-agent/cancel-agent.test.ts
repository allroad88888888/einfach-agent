import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { cancelAgentTool } from './cancel-agent'

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

describe('cancel_agent', () => {
  it('returns the delegation capability error when no runtime is injected', () => {
    const result = cancelAgentTool.execute({ executionId: 'e1' }, makeCtx())

    expect(result).toEqual({
      ok: false,
      error: '子 Agent 委派能力不可用：当前运行环境未注入委派执行器。',
      code: 'AGENT_DELEGATION_UNAVAILABLE',
      retryable: false,
    })
  })

  it('cancels a running execution and reports its terminal status', () => {
    const cancelExecution = vi.fn(() => true)
    const observeExecution = vi.fn(() => ({
      node: {
        id: 'e1',
        graphId: 'g',
        sessionId: 's',
        runId: 'r',
        dependsOn: [],
        type: 'agent-batch' as const,
        status: 'cancelled' as const,
        label: 'child',
        attempt: 1,
        generation: 1,
        effectKeys: [],
        createdAt: 1,
        updatedAt: 2,
      },
      children: [],
    }))

    const result = cancelAgentTool.execute(
      { executionId: ' e1 ' },
      makeCtx({ cancelExecution, observeExecution }),
    )

    expect(cancelExecution).toHaveBeenCalledWith('e1')
    expect(result).toEqual({
      ok: true,
      data: { executionId: 'e1', cancelled: true, status: 'cancelled' },
    })
  })

  it('fails explicitly for an unknown execution', () => {
    const result = cancelAgentTool.execute(
      { executionId: 'missing' },
      makeCtx({
        cancelExecution: vi.fn(() => false),
        observeExecution: vi.fn(() => ({ node: undefined, children: [] })),
      }),
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'AGENT_EXECUTION_UNKNOWN',
      retryable: false,
    })
  })

  it('returns a retryable failure when the execution runtime throws', () => {
    const result = cancelAgentTool.execute(
      { executionId: 'e1' },
      makeCtx({ cancelExecution: vi.fn(() => { throw new Error('runtime unavailable') }) }),
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'AGENT_CANCEL_FAILED',
      retryable: true,
      details: { executionId: 'e1' },
    })
  })
})
