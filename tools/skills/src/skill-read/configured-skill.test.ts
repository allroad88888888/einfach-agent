import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { skillReadTool } from './skill-read'

function context(allowed = true): ToolContext {
  return {
    sessionId: 'session', signal: new AbortController().signal, progress: vi.fn(),
    callTool: vi.fn(), runShell: vi.fn(), renderCard: vi.fn(), saveArtifact: vi.fn(),
    skills: {
      isAllowed: () => allowed,
      list: () => [{ name: 'frozen', description: 'Frozen', triggers: [] }],
      resolveScannedSkill: () => undefined,
      resolveConfiguredSkill: (name) => name === 'frozen'
        ? { content: 'BODY V1', resources: { 'ref.txt': 'RESOURCE V1' } } : undefined,
    },
  }
}

describe('configured skill reads', () => {
  it('reads frozen body and resources only through the governed session capability', async () => {
    await expect(skillReadTool.execute({ name: 'frozen' }, context())).resolves.toMatchObject({
      ok: true, data: { skill: { content: 'BODY V1' } },
    })
    await expect(skillReadTool.execute({ name: 'frozen', resource: 'ref.txt' }, context())).resolves.toMatchObject({
      ok: true, data: { content: 'RESOURCE V1' },
    })
    await expect(skillReadTool.execute({ name: 'frozen' }, context(false))).resolves.toMatchObject({
      ok: false, code: 'SKILL_NOT_FOUND',
    })
  })
})
