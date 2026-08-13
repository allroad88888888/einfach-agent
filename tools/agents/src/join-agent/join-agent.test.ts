import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@web-agent/core/tools'
import { joinAgentTool } from './join-agent'

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

describe('join_agent', () => {
  it('returns the delegation capability error when no runtime is injected', async () => {
    const result = await joinAgentTool.execute({ executionId: 'e1' }, makeCtx())

    expect(result).toEqual({
      ok: false,
      error: '子 Agent 委派能力不可用：当前运行环境未注入委派执行器。',
      code: 'AGENT_DELEGATION_UNAVAILABLE',
      retryable: false,
    })
  })

  it('uses a bounded default wait and returns a completed result', async () => {
    const joinExecution = vi.fn(async () => ({
      executionId: 'e1',
      status: 'succeeded' as const,
      result: { answer: 42 },
    }))

    const result = await joinAgentTool.execute(
      { executionId: ' e1 ' },
      makeCtx({ joinExecution }),
    )

    expect(joinExecution).toHaveBeenCalledWith('e1', 30_000)
    expect(result).toEqual({
      ok: true,
      data: { executionId: 'e1', status: 'succeeded', result: { answer: 42 } },
    })
  })

  it('returns a retryable structured failure on timeout', async () => {
    const joinExecution = vi.fn(async () => ({
      executionId: 'e1',
      status: 'running' as const,
      timedOut: true,
    }))

    const result = await joinAgentTool.execute(
      { executionId: 'e1', timeoutMs: 10 },
      makeCtx({ joinExecution }),
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'AGENT_JOIN_TIMEOUT',
      retryable: true,
      details: { executionId: 'e1', status: 'running', timedOut: true },
    })
  })

  it('surfaces failed and cancelled executions as outer failures', async () => {
    const failed = await joinAgentTool.execute(
      { executionId: 'failed' },
      makeCtx({
        joinExecution: vi.fn(async () => ({
          executionId: 'failed',
          status: 'failed' as const,
          error: 'boom',
        })),
      }),
    )
    const cancelled = await joinAgentTool.execute(
      { executionId: 'cancelled' },
      makeCtx({
        joinExecution: vi.fn(async () => ({
          executionId: 'cancelled',
          status: 'cancelled' as const,
          error: 'cancelled',
        })),
      }),
    )

    expect(failed).toMatchObject({ ok: false, code: 'AGENT_EXECUTION_FAILED' })
    expect(cancelled).toMatchObject({ ok: false, code: 'AGENT_EXECUTION_CANCELLED' })
  })

  it('does not report non-terminal observations as success', async () => {
    const result = await joinAgentTool.execute(
      { executionId: 'e1', timeoutMs: 0 },
      makeCtx({
        joinExecution: vi.fn(async () => ({
          executionId: 'e1',
          status: 'running' as const,
        })),
      }),
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'AGENT_EXECUTION_INCOMPLETE',
      retryable: true,
      details: { status: 'running' },
    })
  })
})
