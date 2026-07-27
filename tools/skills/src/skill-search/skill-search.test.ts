import { describe, it, expect, vi } from 'vitest'
import { skillSearchTool } from './skill-search'
import { createToolRegistry } from '@web-agent/core/tools/toolRegistry'
import type { ToolContext } from '@web-agent/core/tools/types'

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
    expect(skillSearchTool.inputSchema).toMatchObject({ additionalProperties: false })
    expect(skillSearchTool.inputSchema).not.toHaveProperty('required')
  })

  it('正常 query → { ok:true, data.results 是数组 }，且回显 query', async () => {
    const result = await skillSearchTool.execute({ query: '  planning  ', limit: 1 }, makeCtx())

    expect(result).toMatchObject({ ok: true })
    if (!('ok' in result) || result.ok !== true) throw new Error('expected ok:true')
    const data = result.data as { query: string; results: unknown }
    expect(data.query).toBe('planning')
    expect(Array.isArray(data.results)).toBe(true)
    expect((data.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: 'planning',
      matchedFields: expect.any(Array),
      score: expect.any(Number),
    })
  })

  it('空 / 缺失 query 不崩，仍返回 ok:true + 空字符串 query', async () => {
    const registry = createToolRegistry()
    registry.register(skillSearchTool)
    // 必须经过真实 registry.run，确保 schema 校验和 execute 的契约一致。
    const empty = await registry.run('skill_search', {}, makeCtx())
    expect(empty).toMatchObject({ ok: true })
    if ('ok' in empty && empty.ok === true) {
      expect((empty.data as { query: string }).query).toBe('')
      expect(Array.isArray((empty.data as { results: unknown }).results)).toBe(true)
      expect((empty.data as { total: number }).total).toBeGreaterThan(0)
    }
  })

  it('猜错参数名时明确拒绝未知字段，不会静默退化成列出全部', async () => {
    const registry = createToolRegistry()
    registry.register(skillSearchTool)

    const result = await registry.run('skill_search', { skillName: 'planning' }, makeCtx())

    expect(result).toMatchObject({ ok: false })
    if ('ok' in result && result.ok === false) {
      expect(result.error).toContain('skillName')
      expect(result.error).toContain('未声明的额外字段')
    }
  })
})
