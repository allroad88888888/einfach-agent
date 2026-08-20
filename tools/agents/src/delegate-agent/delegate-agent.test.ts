import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { SUBAGENT_TOOL_PROFILES } from '@einfach-agent/core/subagents'
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
        children: {
          items: {
            properties: {
              modelTier: { enum: ['pro', 'flash'] },
              taskCategory: { enum: ['retrieval', 'extraction', 'analysis', 'implementation', 'verification', 'final_acceptance'] },
              riskLevel: { enum: ['low', 'medium', 'high'] },
              requiresTemporalNormalization: { type: 'boolean' },
              finalAcceptance: { type: 'boolean' },
              priorFailureCount: { minimum: 0 },
            },
          },
        },
        toolProfile: { enum: SUBAGENT_TOOL_PROFILES },
        confirmedTools: { type: 'array' },
      },
    })
    const childProfile = (
      delegateAgentTool.inputSchema.properties as unknown as {
        children: { items: { properties: { toolProfile: { enum: readonly string[] } } } }
      }
    ).children.items.properties.toolProfile.enum
    expect(childProfile).toEqual(SUBAGENT_TOOL_PROFILES)
  })

  it('returns an explicit error when runtime capability is missing', async () => {
    const result = await delegateAgentTool.execute(
      { children: [{ objective: 'inspect something' }] },
      makeCtx(),
    )

    expect(result).toEqual({
      ok: false,
      error: '子 Agent 委派能力不可用：当前运行环境未注入委派执行器。',
      code: 'AGENT_DELEGATION_UNAVAILABLE',
      retryable: false,
    })
  })

  it('normalizes input and spawns through ToolContext, returning the handle immediately', async () => {
    const handle = {
      executionId: 'exec-1',
      graphId: 'run',
      nodeIds: ['exec-1'],
      status: 'scheduled' as const,
    }
    const spawnAgents = vi.fn(() => handle)
    const progress = vi.fn()
    const result = await delegateAgentTool.execute(
      {
        children: [{
          objective: ' inspect runtime ',
          mode: ' explore ',
          modelTier: 'flash',
          taskCategory: 'retrieval',
          riskLevel: 'low',
          requiresTemporalNormalization: false,
        }],
        maxConcurrent: 2,
        confirmedTools: ['write_file'],
      },
      makeCtx({ spawnAgents, progress }),
    )

    expect(spawnAgents).toHaveBeenCalledWith({
      children: [{
        objective: 'inspect runtime',
        mode: 'explore',
        modelTier: 'flash',
        taskCategory: 'retrieval',
        riskLevel: 'low',
        requiresTemporalNormalization: false,
      }],
      maxConcurrent: 2,
      confirmedTools: ['write_file'],
    })
    expect(progress).toHaveBeenCalledWith('派发 1 个子 agent')
    expect(result).toEqual({ ok: true, data: handle })
  })

  it('surfaces a failure to spawn as an outer tool failure', async () => {
    const spawnAgents = vi.fn(() => {
      throw new Error('no execution runtime')
    })

    const result = await delegateAgentTool.execute(
      { children: [{ objective: 'inspect something' }] },
      makeCtx({ spawnAgents }),
    )

    expect(result).toEqual({
      ok: false,
      error: 'no execution runtime',
      code: 'AGENT_DELEGATION_FAILED',
      retryable: false,
    })
  })
})
