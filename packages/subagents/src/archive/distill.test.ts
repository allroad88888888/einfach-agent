import { describe, expect, it } from 'vitest'
import { distillDelegateSkills } from './distill'
import type { SubagentNodeRecord } from '@web-agent/core/subagents/types'

function node(path: string): SubagentNodeRecord {
  return {
    id: `run:${path}`,
    treeId: 'run',
    sessionId: 'session',
    path,
    parentPath: 'root',
    status: 'queued',
    objective: 'inspect',
    depth: 1,
    dispatchCounter: 0,
    childCounter: 0,
    createdAt: 1,
    updatedAt: 1,
    inheritedSkillFiles: ['parent.md'],
    inheritedSkillIds: ['sk_parent'],
    localSkillFiles: [],
    localSkillIds: [],
  }
}

describe('distillDelegateSkills', () => {
  it('creates long-lived skill metadata and links child briefs to the parent core skill id', async () => {
    const result = await distillDelegateSkills({
      conversationId: 'session',
      runId: 'run',
      cacheBasePath: '.webAgent-archive/conversations/session/runs/run',
      parentPath: 'root',
      parentTranscript: 'user asks for a tree agent runtime',
      inheritedSkillFiles: ['parent.md'],
      inheritedSkillIds: ['sk_parent'],
      children: [{ node: node('root-01'), spec: { objective: 'inspect runtime' } }],
      chat: async (input) => (input.purpose === 'core' ? '# Core\n\nRuntime constraints.' : '# Brief\n\nInspect runtime.'),
    })

    expect(result.coreSkill).toMatchObject({
      conversationId: 'session',
      runId: 'run',
      agentPath: 'root',
      ttl: 'permanent',
      promotion: 'candidate',
      inheritSkillIds: ['sk_parent'],
    })
    expect(result.coreSkill.skillId).toMatch(/^sk_/)
    expect(result.childSkills[0]).toMatchObject({
      conversationId: 'session',
      runId: 'run',
      agentPath: 'root-01',
      ttl: 'permanent',
      promotion: 'candidate',
    })
    expect(result.childSkills[0].inheritSkillIds).toEqual(['sk_parent', result.coreSkill.skillId])
    expect(result.childSkills[0].source.parentSkillIds).toEqual(['sk_parent', result.coreSkill.skillId])
  })

  it('uses the parent dispatch index to avoid core file/name collisions', async () => {
    const result01 = await distillDelegateSkills({
      conversationId: 'session',
      runId: 'run',
      cacheBasePath: '.webAgent-archive/conversations/session/runs/run',
      parentPath: 'root',
      parentDispatchIndex: 1,
      parentTranscript: 'user asks for first batch',
      inheritedSkillFiles: ['parent.md'],
      inheritedSkillIds: ['sk_parent'],
      children: [{ node: node('root-01'), spec: { objective: 'inspect runtime' } }],
      chat: async (input) => (input.purpose === 'core' ? '# Core' : '# Brief'),
    })

    const result02 = await distillDelegateSkills({
      conversationId: 'session',
      runId: 'run',
      cacheBasePath: '.webAgent-archive/conversations/session/runs/run',
      parentPath: 'root',
      parentDispatchIndex: 2,
      parentTranscript: 'user asks for second batch',
      inheritedSkillFiles: ['parent.md'],
      inheritedSkillIds: ['sk_parent'],
      children: [{ node: node('root-02'), spec: { objective: 'inspect runtime' } }],
      chat: async (input) => (input.purpose === 'core' ? '# Core' : '# Brief'),
    })

    expect(result01.coreSkill.filename).toBe('root.01-core.md')
    expect(result02.coreSkill.filename).toBe('root.02-core.md')
    expect(result02.coreSkill.path).toBe(
      '.webAgent-archive/conversations/session/runs/run/skills/root.02-core.md',
    )
    expect(result01.coreSkill.skillId).not.toBe(result02.coreSkill.skillId)
  })

  it('supports best_effort strategy with graceful child brief fallback', async () => {
    const calls: string[] = []
    const result = await distillDelegateSkills({
      conversationId: 'session',
      runId: 'run',
      cacheBasePath: '.webAgent-archive/conversations/session/runs/run',
      parentPath: 'root',
      parentTranscript: 'user asks for fallback test',
      inheritedSkillFiles: ['parent.md'],
      inheritedSkillIds: ['sk_parent'],
      children: [
        { node: node('root-01'), spec: { objective: 'inspect runtime' } },
        { node: node('root-02'), spec: { objective: 'inspect ui' } },
      ],
      chat: async (input) => {
        calls.push(`${input.purpose}:${input.agentPath}`)
        if (input.purpose === 'child_brief' && input.agentPath === 'root-02') {
          throw new Error('brief generation failed')
        }
        return `# ${input.purpose}\n\nmocked content`
      },
      strategy: 'parallel_best_effort',
    })

    const fallback = result.childSkills.find((skill) => skill.path.includes('root-02'))
    expect(fallback?.content).toContain('fallback_reason')
    expect(result.childSkills).toHaveLength(2)
    expect(result.childSkills[0].content).toContain('mocked content')
    expect(result.coreSkill.path).toMatch(/\.md$/)
    expect(calls.filter((value) => value.startsWith('core:')).length).toBe(1)
  })

  it('wait_all strategy still fails the whole batch when any child brief fails', async () => {
    await expect(() =>
      distillDelegateSkills({
        conversationId: 'session',
        runId: 'run',
        cacheBasePath: '.webAgent-archive/conversations/session/runs/run',
        parentPath: 'root',
        parentTranscript: 'user asks for wait_all failure test',
        inheritedSkillFiles: ['parent.md'],
        inheritedSkillIds: ['sk_parent'],
        children: [{ node: node('root-01'), spec: { objective: 'inspect runtime' } }],
        chat: async (input) => {
          if (input.purpose === 'child_brief') throw new Error('brief generation failed')
          return '# core\n\nmocked content'
        },
        strategy: 'parallel_wait_all',
      }),
    ).rejects.toThrow('brief generation failed')
  })
})
