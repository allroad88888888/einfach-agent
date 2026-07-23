import { describe, it, expect, vi } from 'vitest'
import { skillReadTool } from './skill-read'
import type { ToolContext } from '@web-agent/core/tools/types'

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

describe('tools/skill-read/skill-read', () => {
  it('身份/runtime/skill 元数据齐备（含 content）', () => {
    expect(skillReadTool.name).toBe('skill_read')
    expect(skillReadTool.runtime).toBe('internal')
    expect(skillReadTool.skill.description).toBeTruthy()
    expect(skillReadTool.skill.content.length).toBeGreaterThan(0)
    expect(skillReadTool.inputSchema).toMatchObject({ required: ['name'] })
  })

  it('已知 skill 名（web-chat-agent）→ { ok:true, data.skill.content 非空 }', async () => {
    const result = await skillReadTool.execute({ name: 'web-chat-agent' }, makeCtx())

    expect(result).toMatchObject({ ok: true })
    if (!('ok' in result) || result.ok !== true) throw new Error('expected ok:true')
    const data = result.data as { name: string; skill: { content: string } }
    expect(data.name).toBe('web-chat-agent')
    expect(data.skill.content.length).toBeGreaterThan(0)
  })

  it('未知名 → { ok:false, error 含 "not found" }', async () => {
    const result = await skillReadTool.execute({ name: 'nope-skill' }, makeCtx())

    expect(result).toMatchObject({ ok: false })
    if (!('ok' in result) || result.ok !== false) throw new Error('expected ok:false')
    expect(result.error).toContain('not found')
    expect(result.error).toContain('nope-skill')
  })

  it('缺失 name 不崩，回 ok:false', async () => {
    const result = await skillReadTool.execute({}, makeCtx())
    expect(result).toMatchObject({ ok: false })
  })
})
