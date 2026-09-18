import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { skillSearchTool } from './skill-search'

function context(allowed: readonly string[]): ToolContext {
  const allowedNames = new Set(allowed)
  return {
    sessionId: 'session',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
    skills: {
      list: () => [
        { name: 'planning', description: 'planning', triggers: [] },
        { name: 'project/release', description: 'release', triggers: [] },
        { name: 'user/notes', description: 'notes', triggers: [] },
        { name: 'form-help', description: 'fills customer forms', triggers: ['intake'] },
      ].filter((skill) => allowedNames.has(skill.name)),
      resolveScannedSkill: () => undefined,
      isAllowed: (name: string) => allowedNames.has(name),
    },
  }
}

describe('skill_search session capability filtering', () => {
  it('returns only allowed built-in/project/user stable names', async () => {
    const result = await skillSearchTool.execute(
      {},
      context(['planning', 'project/release']),
    )
    expect(result).toMatchObject({ ok: true })
    const names = (result as { data: { results: Array<{ name: string }> } })
      .data.results.map((skill) => skill.name)

    expect(names).toContain('planning')
    expect(names).toContain('project/release')
    expect(names).not.toContain('web-chat-agent')
    expect(names).not.toContain('user/notes')
  })

  it('a query naming a disabled built-in returns no result and no suggestions', async () => {
    const result = await skillSearchTool.execute(
      { query: 'web-chat-agent' },
      context(['planning']),
    )
    const data = (result as { data: { results: unknown[]; total: number } }).data

    expect(data.results).toEqual([])
    expect(data.total).toBe(0)
  })

  it.each(['form-help', 'customer forms', 'intake'])('searches configured skills by %s', async (query) => {
    const result = await skillSearchTool.execute({ query }, context(['form-help']))
    expect((result as { data: { results: Array<{ name: string }> } }).data.results[0]?.name).toBe('form-help')
  })

  it('does not reveal a configured skill excluded by the session allowlist', async () => {
    const result = await skillSearchTool.execute({ query: 'intake' }, context([]))
    expect((result as { data: { results: unknown[] } }).data.results).toEqual([])
  })
})
