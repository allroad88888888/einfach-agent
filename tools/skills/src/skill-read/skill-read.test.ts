import { describe, it, expect, vi } from 'vitest'
import { skillReadTool } from './skill-read'
import { truncateSkillResourceContent } from '@web-agent/core/skills/registry'
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

  // --- 阶段 1（docs/skills-tree-blueprint.md）：L3 资源读取 -----------------------------------

  it('省略 resource 时 data.resources 是可读资源键列表（与 skill.resources 一致）', async () => {
    const result = await skillReadTool.execute({ name: 'planning' }, makeCtx())

    expect(result).toMatchObject({ ok: true })
    if (!('ok' in result) || result.ok !== true) throw new Error('expected ok:true')
    const data = result.data as { name: string; skill: { resources: string[] }; resources: string[] }
    expect(Array.isArray(data.resources)).toBe(true)
    expect(data.resources).toContain('references/evaluation.md')
    expect(data.skill.resources).toEqual(data.resources)
  })

  it('无资源的 skill（web-chat-agent）→ data.resources 是空数组，不报错', async () => {
    const result = await skillReadTool.execute({ name: 'web-chat-agent' }, makeCtx())

    expect(result).toMatchObject({ ok: true })
    if (!('ok' in result) || result.ok !== true) throw new Error('expected ok:true')
    const data = result.data as { resources: string[] }
    expect(data.resources).toEqual([])
  })

  it('带 resource 读已知资源 → ok:true，返回 name/resource/content/truncated', async () => {
    const result = await skillReadTool.execute(
      { name: 'planning', resource: 'references/evaluation.md' },
      makeCtx(),
    )

    expect(result).toMatchObject({ ok: true })
    if (!('ok' in result) || result.ok !== true) throw new Error('expected ok:true')
    const data = result.data as { name: string; resource: string; content: string; truncated: boolean }
    expect(data.name).toBe('planning')
    expect(data.resource).toBe('references/evaluation.md')
    expect(data.content.length).toBeGreaterThan(0)
    expect(data.truncated).toBe(false)
  })

  it('带 resource 读未知资源键 → ok:false，错误文案含该 skill 可用资源键列表', async () => {
    const result = await skillReadTool.execute(
      { name: 'planning', resource: 'references/does-not-exist.md' },
      makeCtx(),
    )

    expect(result).toMatchObject({ ok: false })
    if (!('ok' in result) || result.ok !== false) throw new Error('expected ok:false')
    expect(result.error).toContain('references/does-not-exist.md')
    // 引导模型自我修正：错误文案里能看到真正可用的键。
    expect(result.error).toContain('references/evaluation.md')
  })

  it('带 resource 但 skill 本身不存在 → ok:false，"not found" 且不崩', async () => {
    const result = await skillReadTool.execute({ name: 'nope-skill', resource: 'references/x.md' }, makeCtx())

    expect(result).toMatchObject({ ok: false })
    if (!('ok' in result) || result.ok !== false) throw new Error('expected ok:false')
    expect(result.error).toContain('not found')
    expect(result.error).toContain('nope-skill')
  })

  it('resource 传非字符串（如数字）时按省略处理，退回读正文而不是崩溃', async () => {
    const result = await skillReadTool.execute({ name: 'web-chat-agent', resource: 123 }, makeCtx())

    expect(result).toMatchObject({ ok: true })
    if (!('ok' in result) || result.ok !== true) throw new Error('expected ok:true')
    const data = result.data as { skill?: { content: string } }
    expect(data.skill?.content.length).toBeGreaterThan(0)
  })

  it('截断逻辑：registry 资源是编译期静态内容、没有天然超过 64KB 的样本，经导出的纯函数直接注入合成超长字符串验证阈值', () => {
    const longContent = 'x'.repeat(70_000)
    const { content, truncated } = truncateSkillResourceContent(longContent)

    expect(truncated).toBe(true)
    // 保留前 65536 字符 + 截断说明，因此总长度大于上限。
    expect(content.length).toBeGreaterThan(65536)
    expect(content.startsWith('x'.repeat(65536))).toBe(true)
    expect(content).toContain('截断')

    const shortContent = 'y'.repeat(100)
    expect(truncateSkillResourceContent(shortContent)).toEqual({ content: shortContent, truncated: false })
  })
})
