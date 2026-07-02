import { describe, it, expect, vi } from 'vitest'
import { skillSearchTool } from './skill-search'
import type { ToolContext } from '../types'

// 最小 ctx：这些 internal 工具不该碰任何副作用面，但仍传全套满足签名。
function makeCtx(): ToolContext {
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
  }
}

describe('tools/skill-search/skill-search', () => {
  it('身份/runtime/skill 元数据齐备（含 content）', () => {
    expect(skillSearchTool.name).toBe('skill_search')
    expect(skillSearchTool.runtime).toBe('internal')
    expect(skillSearchTool.skill.description).toBeTruthy()
    expect(skillSearchTool.skill.content.length).toBeGreaterThan(0)
    // 必填 query
    expect(skillSearchTool.inputSchema).toMatchObject({ required: ['query'] })
  })

  it('正常 query → { ok:true, data.results 是数组 }，且回显 query', async () => {
    const result = await skillSearchTool.execute({ query: 'skill' }, makeCtx())

    expect(result).toMatchObject({ ok: true })
    if (!('ok' in result) || result.ok !== true) throw new Error('expected ok:true')
    const data = result.data as { query: string; results: unknown }
    expect(data.query).toBe('skill')
    expect(Array.isArray(data.results)).toBe(true)
  })

  it('空 / 缺失 query 不崩，仍返回 ok:true + 空字符串 query', async () => {
    const empty = await skillSearchTool.execute({}, makeCtx())
    expect(empty).toMatchObject({ ok: true })
    if ('ok' in empty && empty.ok === true) {
      expect((empty.data as { query: string }).query).toBe('')
      expect(Array.isArray((empty.data as { results: unknown }).results)).toBe(true)
    }
  })
})
