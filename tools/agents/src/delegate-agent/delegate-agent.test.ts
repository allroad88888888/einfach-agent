import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import {
  DELEGATABLE_DANGEROUS_TOOLS,
  SUBAGENT_MODEL_TIERS,
  SUBAGENT_RISK_LEVELS,
  SUBAGENT_TASK_CATEGORIES,
  SUBAGENT_TOOL_PROFILES,
  SUBAGENT_VERIFICATION_TOOL,
} from '@einfach-agent/core/subagents'
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
              modelTier: { enum: SUBAGENT_MODEL_TIERS },
              taskCategory: { enum: SUBAGENT_TASK_CATEGORIES },
              riskLevel: { enum: SUBAGENT_RISK_LEVELS },
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

  it('derives every schema enum from the public capability collections', () => {
    const properties = delegateAgentTool.inputSchema.properties as unknown as {
      children: {
        items: {
          properties: {
            modelTier: { enum: readonly string[] }
            taskCategory: { enum: readonly string[] }
            riskLevel: { enum: readonly string[] }
            confirmedTools: { items: { enum: readonly string[] } }
          }
        }
      }
      toolProfile: { enum: readonly string[] }
      confirmedTools: { items: { enum: readonly string[] } }
    }
    const child = properties.children.items.properties

    expect(child.modelTier.enum).toEqual(SUBAGENT_MODEL_TIERS)
    expect(child.taskCategory.enum).toEqual(SUBAGENT_TASK_CATEGORIES)
    expect(child.riskLevel.enum).toEqual(SUBAGENT_RISK_LEVELS)
    expect(child.confirmedTools.items.enum).toEqual(DELEGATABLE_DANGEROUS_TOOLS)
    expect(properties.toolProfile.enum).toEqual(SUBAGENT_TOOL_PROFILES)
    expect(properties.confirmedTools.items.enum).toEqual(DELEGATABLE_DANGEROUS_TOOLS)
  })

  it('lists every capability value in the guide', () => {
    const guide = delegateAgentTool.skill.content
    const guideValues = (parameter: string, marker: string) => {
      const line = guide.split('\n').find((candidate) => candidate.startsWith(`- \`${parameter}\``))
      expect(line).toBeDefined()
      const values = line!.split(marker)[1]?.split('.')[0]
      expect(values).toBeDefined()
      return Array.from(values!.matchAll(/`([^`]+)`/g), (match) => match[1])
    }

    expect(guideValues('children[].modelTier', 'Allowed values: ')).toEqual(SUBAGENT_MODEL_TIERS)
    expect(guideValues('children[].taskCategory', 'allowed values: ')).toEqual(SUBAGENT_TASK_CATEGORIES)
    expect(guideValues('children[].riskLevel', 'allowed values: ')).toEqual(SUBAGENT_RISK_LEVELS)
    expect(guideValues('children[].toolProfile', 'allowed values: ')).toEqual(SUBAGENT_TOOL_PROFILES)
    expect(guideValues('toolProfile', 'Allowed values: ')).toEqual(SUBAGENT_TOOL_PROFILES)
    expect(guideValues('confirmedTools', 'Accepted names: ')).toEqual(DELEGATABLE_DANGEROUS_TOOLS)
  })

  it('documents the workspace_verify capability and full narrowing hierarchy', () => {
    const guide = delegateAgentTool.skill.content

    expect(guide).toContain(`\`workspace_verify\` additionally permits \`${SUBAGENT_VERIFICATION_TOOL}\``)
    expect(guide).toContain('`workspace_verify` → `workspace_read` → `delegate_only`')
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
