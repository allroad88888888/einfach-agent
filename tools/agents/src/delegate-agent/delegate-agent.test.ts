import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@web-agent/core/tools/types'
import { delegateAgentTool } from './delegate-agent'

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(async (input) => ({
      platform: input.platform,
      shell: 'test',
      command: input.command,
      cwd: input.cwd ?? '',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      truncated: false,
    })),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    ...overrides,
  }
}

describe('delegate_agent tool', () => {
  it('exposes internal lazy-tool metadata', () => {
    expect(delegateAgentTool.name).toBe('delegate_agent')
    expect(delegateAgentTool.runtime).toBe('internal')
    expect(delegateAgentTool.skill.description).toContain('子 agent')
    expect(delegateAgentTool.inputSchema).toMatchObject({
      required: ['children'],
      properties: {
        toolProfile: { enum: ['delegate_only', 'workspace_read'] },
        confirmedTools: { type: 'array' },
      },
    })
  })

  it('returns an explicit error when runtime capability is missing', async () => {
    const result = await delegateAgentTool.execute(
      { children: [{ objective: 'inspect something' }] },
      makeCtx(),
    )

    expect(result).toEqual({
      ok: false,
      error: 'delegate_agent unavailable: ctx.delegateAgents is not configured',
    })
  })

  it('normalizes input and delegates through ToolContext', async () => {
    const delegateAgents = vi.fn(async (input) => ({
      treeId: 'run',
      conversationId: 's',
      runId: 'run',
      parentPath: 'root',
      strategy: input.strategy ?? 'parallel_wait_all',
      status: 'done' as const,
      summary: { total: 0, done: 0, failed: 0, cancelled: 0 },
      cacheBasePath: '.agent-archive/conversations/s/runs/run',
      archiveBasePath: '.agent-archive/conversations/s/runs/run',
      eventLog: '.agent-archive/conversations/s/runs/run/events.jsonl',
      skillFiles: [],
      skillIds: [],
      budgetUsage: {
        totalNodes: { used: 1, limit: 64 },
        modelCalls: { used: 0, limit: 128 },
      },
      children: [],
    }))
    const progress = vi.fn()
    const result = await delegateAgentTool.execute(
      {
        children: [{ objective: ' inspect runtime ', mode: ' explore ' }],
        maxConcurrent: 2,
        confirmedTools: ['write_file'],
      },
      makeCtx({ delegateAgents, progress }),
    )

    expect(delegateAgents).toHaveBeenCalledWith({
      children: [{ objective: 'inspect runtime', mode: 'explore' }],
      maxConcurrent: 2,
      confirmedTools: ['write_file'],
    })
    expect(progress).toHaveBeenCalledWith('派发 1 个子 agent')
    expect(result).toMatchObject({ ok: true })
  })
})
