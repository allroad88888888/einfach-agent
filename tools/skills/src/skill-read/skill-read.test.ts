import { describe, it, expect, vi } from 'vitest'
import { skillReadTool } from './skill-read'
import { truncateSkillResourceContent } from '../registry'
import type { ToolContext } from '@web-agent/core/tools'

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

// ===========================================================================
// 项目 skills（project/ 前缀）—— docs/project-skills-blueprint.md 阶段 C
// ===========================================================================

/** 造一个带扫描 skills 能力的 ctx；readWorkspaceFile 返回真实的 {ok,data} 桥形状。 */
function makeProjectCtx(opts?: {
  files?: Record<string, string>
  readFails?: string
}): ToolContext {
  const files = opts?.files ?? {
    '.webAgent/skills/deploy-flow/SKILL.md':
      '---\nname: deploy-flow\ndescription: 何时用：发布相关\n---\n\n正文第一行\n正文第二行\n',
    '.webAgent/skills/deploy-flow/references/checklist.md': '# checklist\n- 一\n- 二\n',
    '.claude/skills/notes/SKILL.md':
      '---\nname: notes\ndescription: 主目录笔记\n---\n\n主目录正文\n',
  }
  const ctx = makeCtx() as ToolContext & Record<string, unknown>
  ctx.readWorkspaceFile = vi.fn(async ({ path }: { path: string }) => {
    if (opts?.readFails) return { ok: false, error: opts.readFails }
    const content = files[path]
    if (content === undefined) return { ok: false, error: `no such file: ${path}` }
    return { ok: true, data: { path, content, truncated: false, bytes: content.length } }
  })
  ctx.skills = {
    list: () => [
      { name: 'project/deploy-flow', description: '何时用：发布相关', triggers: [] },
      { name: 'user/notes', description: '主目录笔记', triggers: [] },
    ],
    resolveScannedSkill: (name: string) => {
      if (name === 'project/deploy-flow') {
        return {
          filePath: '.webAgent/skills/deploy-flow/SKILL.md',
          resources: { 'references/checklist.md': '.webAgent/skills/deploy-flow/references/checklist.md' },
          rootPath: '/workspace',
        }
      }
      if (name === 'user/notes') {
        return {
          filePath: '.claude/skills/notes/SKILL.md',
          resources: {} as Record<string, string>,
          rootPath: '/home/me',
        }
      }
      return undefined
    },
  }
  return ctx
}

describe('tools/skill-read/skill-read · 项目 skills', () => {
  it('读项目正文 → 剥掉 frontmatter，只回正文，并附资源目录', async () => {
    const result = await skillReadTool.execute({ name: 'project/deploy-flow' }, makeProjectCtx())
    expect(result).toMatchObject({ ok: true })
    const data = (result as { data: { skill: { content: string }; resources: string[] } }).data
    // frontmatter 已在 L1 清单里给过，正文响应不该重复它
    expect(data.skill.content).toBe('正文第一行\n正文第二行\n')
    expect(data.skill.content).not.toContain('description:')
    expect(data.resources).toEqual(['references/checklist.md'])
  })

  it('读项目 L3 资源 → 按快照白名单里的路径取文件内容', async () => {
    const ctx = makeProjectCtx()
    const result = await skillReadTool.execute(
      { name: 'project/deploy-flow', resource: 'references/checklist.md' },
      ctx,
    )
    expect(result).toMatchObject({ ok: true })
    expect((result as { data: { content: string } }).data.content).toBe('# checklist\n- 一\n- 二\n')
    // 路径必须来自快照，而不是把模型给的 resource 串拼进去
    expect(ctx.readWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: '.webAgent/skills/deploy-flow/references/checklist.md' }),
    )
  })

  it('资源键不在白名单 → SKILL_RESOURCE_NOT_FOUND 且列出可读键（不谎报 skill 不存在）', async () => {
    const result = await skillReadTool.execute(
      { name: 'project/deploy-flow', resource: '../../../etc/passwd' },
      makeProjectCtx(),
    )
    expect(result).toMatchObject({ ok: false })
    const failure = result as { code: string; error: string; details?: { availableResources: string[] } }
    expect(failure.code).toBe('SKILL_RESOURCE_NOT_FOUND')
    expect(failure.error).toContain('references/checklist.md')
    expect(failure.details?.availableResources).toEqual(['references/checklist.md'])
  })

  it('穿越式资源键不会落到 readWorkspaceFile —— 白名单在前，桥不背这个锅', async () => {
    const ctx = makeProjectCtx()
    await skillReadTool.execute({ name: 'project/deploy-flow', resource: '../../secrets.env' }, ctx)
    expect(ctx.readWorkspaceFile).not.toHaveBeenCalled()
  })

  it('未知 project/* → SKILL_NOT_FOUND 且提示当前可用的项目 skills', async () => {
    const result = await skillReadTool.execute({ name: 'project/nope' }, makeProjectCtx())
    expect(result).toMatchObject({ ok: false })
    const failure = result as { code: string; hint?: string }
    expect(failure.code).toBe('SKILL_NOT_FOUND')
    expect(failure.hint).toContain('project/deploy-flow')
  })

  it('桥返回 {ok:false} → 报 READ_FAILED 并透出原因，绝不静默返回空正文', async () => {
    const result = await skillReadTool.execute(
      { name: 'project/deploy-flow' },
      makeProjectCtx({ readFails: 'path `.webAgent` is not accessible' }),
    )
    // 回归护栏：旧实现直接取 .content，失败时得到 undefined→''，于是 ok:true + 空 skill。
    expect(result).toMatchObject({ ok: false })
    expect((result as { error: string }).error).toContain('is not accessible')
  })

  it('ctx 无 skills 能力（旧宿主）→ project/* 明确报未找到，不抛异常', async () => {
    const result = await skillReadTool.execute({ name: 'project/deploy-flow' }, makeCtx())
    expect(result).toMatchObject({ ok: false })
    expect((result as { code: string }).code).toBe('SKILL_NOT_FOUND')
  })

  it('user/* 用主目录当读取根 —— 缺省会被注入会话 workspace，那条路径必然越界', async () => {
    const ctx = makeProjectCtx()
    const result = await skillReadTool.execute({ name: 'user/notes' }, ctx)

    expect(result).toMatchObject({ ok: true })
    expect((result as { data: { skill: { content: string } } }).data.skill.content).toBe('主目录正文\n')
    expect(ctx.readWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '.claude/skills/notes/SKILL.md',
        workspaceRoot: '/home/me',
      }),
    )
  })

  it('project/* 读取仍显式带会话 workspace 根，与主目录那条走同一套坐标', async () => {
    const ctx = makeProjectCtx()
    await skillReadTool.execute({ name: 'project/deploy-flow' }, ctx)
    expect(ctx.readWorkspaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '.webAgent/skills/deploy-flow/SKILL.md',
        workspaceRoot: '/workspace',
      }),
    )
  })

  it('未知 user/* → 提示里列出的是全部扫描 skills，不只项目那批', async () => {
    const result = await skillReadTool.execute({ name: 'user/nope' }, makeProjectCtx())
    expect(result).toMatchObject({ ok: false })
    const failure = result as { code: string; hint?: string }
    expect(failure.code).toBe('SKILL_NOT_FOUND')
    expect(failure.hint).toContain('user/notes')
    expect(failure.hint).toContain('project/deploy-flow')
  })
})
