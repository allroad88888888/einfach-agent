import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { skillReadTool } from './skill-read'

function context(allowed: readonly string[]): ToolContext {
  const allowedNames = new Set(allowed)
  const ctx: ToolContext = {
    sessionId: 'session',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(),
    readWorkspaceFile: vi.fn(async () => ({
      ok: true,
      data: { content: '# secret', truncated: false },
    })),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    skills: {
      list: () => [],
      resolveScannedSkill: vi.fn(() => ({
        filePath: 'SKILL.md',
        resources: {},
        rootPath: '/workspace',
      })),
      isAllowed: (name: string) => allowedNames.has(name),
    },
  }
  return ctx
}

describe('skill_read session capability filtering', () => {
  it.each(['web-chat-agent', 'project/secret', 'user/secret'])(
    'directly guessed disabled name %s is unreadable before any content access',
    async (name) => {
      const ctx = context([])
      const result = await skillReadTool.execute({ name }, ctx)

      expect(result).toEqual({
        ok: false,
        error: 'skill not found or not enabled for this conversation',
        code: 'SKILL_NOT_FOUND',
        retryable: false,
        hint: 'Call skill_search to discover Skills enabled for this conversation.',
      })
      expect(ctx.skills?.resolveScannedSkill).not.toHaveBeenCalled()
      expect(ctx.readWorkspaceFile).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain(name)
    },
  )

  it('an allowed built-in remains readable', async () => {
    const result = await skillReadTool.execute(
      { name: 'web-chat-agent' },
      context(['web-chat-agent']),
    )

    expect(result).toMatchObject({ ok: true, data: { name: 'web-chat-agent' } })
  })
})
