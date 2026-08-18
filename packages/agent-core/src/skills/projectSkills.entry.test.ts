import { describe, expect, it } from 'vitest'
import { buildProjectSkillEntry, MAX_PROJECT_RESOURCES_PER_SKILL } from './projectSkills'

describe('buildProjectSkillEntry', () => {
  function validFrontmatter(dirName = 'deploy-flow') {
    return [
      '---',
      'name: my-skill',
      'description: 何时用：测试；何时不用：无关',
      'triggers: [deploy, ci]',
      '---',
    ].join('\n')
  }

  it('完整的 skill 条目', () => {
    const result = buildProjectSkillEntry({
      dirName: 'deploy-flow',
      origin: 'agent',
      scope: 'project',
      rootPath: '/workspace',
      filePath: '.webAgent/skills/deploy-flow/SKILL.md',
      frontmatterRaw: validFrontmatter(),
      resourceFiles: [],
    })
    expect(result.entry).toBeDefined()
    expect(result.entry!.name).toBe('project/my-skill')
    expect(result.entry!.description).toBe('何时用：测试；何时不用：无关')
    expect(result.entry!.triggers).toEqual(['deploy', 'ci'])
    expect(result.entry!.filePath).toBe('.webAgent/skills/deploy-flow/SKILL.md')
    expect(result.entry!.origin).toBe('agent')
    expect(result.entry!.resources).toEqual({})
    expect(result.diagnostics).toEqual([])
  })

  it('name 缺失 → 用目录名', () => {
    const raw = [
      '---',
      'description: 只有描述',
      '---',
    ].join('\n')
    const result = buildProjectSkillEntry({
      dirName: 'my-dir',
      origin: 'agent',
      scope: 'project',
      rootPath: '/workspace',
      filePath: '.webAgent/skills/my-dir/SKILL.md',
      frontmatterRaw: raw,
      resourceFiles: [],
    })
    expect(result.entry!.name).toBe('project/my-dir')
  })

  it('name 不合法 → 丢弃（返回 undefined entry + diagnostics）', () => {
    const raw = [
      '---',
      'name: Bad_Name!',
      'description: 有描述',
      '---',
    ].join('\n')
    const result = buildProjectSkillEntry({
      dirName: 'bad-dir',
      origin: 'agent',
      scope: 'project',
      rootPath: '/workspace',
      filePath: '.webAgent/skills/bad-dir/SKILL.md',
      frontmatterRaw: raw,
      resourceFiles: [],
    })
    expect(result.entry).toBeUndefined()
    expect(result.diagnostics.length).toBeGreaterThan(0)
    expect(result.diagnostics[0]).toContain('Bad_Name!')
    expect(result.diagnostics[0]).toContain('不符合规范')
  })

  it('name 未提供但目录名也不合法 → 丢弃', () => {
    const raw = [
      '---',
      'description: desc',
      '---',
    ].join('\n')
    const result = buildProjectSkillEntry({
      dirName: 'Bad Dir!',
      origin: 'agent',
      scope: 'project',
      rootPath: '/workspace',
      filePath: '.webAgent/skills/Bad Dir!/SKILL.md',
      frontmatterRaw: raw,
      resourceFiles: [],
    })
    expect(result.entry).toBeUndefined()
  })

  it('description 缺失 → 丢弃', () => {
    const raw = [
      '---',
      'name: no-desc',
      '---',
    ].join('\n')
    const result = buildProjectSkillEntry({
      dirName: 'no-desc',
      origin: 'agent',
      scope: 'project',
      rootPath: '/workspace',
      filePath: '.webAgent/skills/no-desc/SKILL.md',
      frontmatterRaw: raw,
      resourceFiles: [],
    })
    expect(result.entry).toBeUndefined()
    expect(result.diagnostics.some((d) => d.includes('缺少 description'))).toBe(true)
  })

  it('无 frontmatter → 丢弃（同 description 缺失）', () => {
    const result = buildProjectSkillEntry({
      dirName: 'no-fm',
      origin: 'agent',
      scope: 'project',
      rootPath: '/workspace',
      filePath: '.webAgent/skills/no-fm/SKILL.md',
      frontmatterRaw: '# 直接就是 markdown 正文',
      resourceFiles: [],
    })
    expect(result.entry).toBeUndefined()
    expect(result.diagnostics.some((d) => d.includes('缺少 description'))).toBe(true)
  })

  it('description 卫生化后为空 → 丢弃', () => {
    const raw = [
      '---',
      'name: empty-desc',
      'description: ""',
      '---',
    ].join('\n')
    const result = buildProjectSkillEntry({
      dirName: 'empty-desc',
      origin: 'agent',
      scope: 'project',
      rootPath: '/workspace',
      filePath: '.webAgent/skills/empty-desc/SKILL.md',
      frontmatterRaw: raw,
      resourceFiles: [],
    })
    expect(result.entry).toBeUndefined()
  })

  it('description 被截断到 160', () => {
    const longDesc = 'a'.repeat(200)
    const raw = [
      '---',
      'name: long-desc',
      `description: "${longDesc}"`,
      '---',
    ].join('\n')
    const result = buildProjectSkillEntry({
      dirName: 'long-desc',
      origin: 'agent',
      scope: 'project',
      rootPath: '/workspace',
      filePath: '.webAgent/skills/long-desc/SKILL.md',
      frontmatterRaw: raw,
      resourceFiles: [],
    })
    expect(result.entry).toBeDefined()
    // 160 字符预算 + 1 个省略号标记；并回一条可操作的 diagnostics 给仓库作者
    expect(result.entry!.description).toHaveLength(161)
    expect(result.entry!.description.endsWith('…')).toBe(true)
    expect(result.diagnostics.join('\n')).toContain('已截断')
  })

  it('description 含控制字符 → 剥离后再截断', () => {
    const raw = [
      '---',
      'name: clean',
      'description: "hello\x00\x01world this is a test of sanitization with control chars in the middle"',
      '---',
    ].join('\n')
    const result = buildProjectSkillEntry({
      dirName: 'clean',
      origin: 'agent',
      scope: 'project',
      rootPath: '/workspace',
      filePath: '.webAgent/skills/clean/SKILL.md',
      frontmatterRaw: raw,
      resourceFiles: [],
    })
    expect(result.entry).toBeDefined()
    expect(result.entry!.description).not.toContain('\x00')
    expect(result.entry!.description).not.toContain('\x01')
  })

  it('资源白名单：只接受白名单扩展名', () => {
    const result = buildProjectSkillEntry({
      dirName: 'with-resources',
      origin: 'agent',
      scope: 'project',
      rootPath: '/workspace',
      filePath: '.webAgent/skills/with-resources/SKILL.md',
      frontmatterRaw: validFrontmatter('with-resources'),
      resourceFiles: [
        { relativePath: 'references/guide.md', workspacePath: '.webAgent/skills/with-resources/references/guide.md' },
        { relativePath: 'references/script.sh', workspacePath: '.webAgent/skills/with-resources/references/script.sh' },
      ],
    })
    expect(result.entry).toBeDefined()
    expect(result.entry!.resources).toHaveProperty('references/guide.md')
    // .sh 不在白名单
    expect(result.entry!.resources).not.toHaveProperty('references/script.sh')
    expect(result.diagnostics.some((d) => d.includes('script.sh') && d.includes('非白名单'))).toBe(true)
  })

  it('资源上限截断：超过 MAX_PROJECT_RESOURCES_PER_SKILL', () => {
    const files = Array.from({ length: MAX_PROJECT_RESOURCES_PER_SKILL + 2 }, (_, i) => ({
      relativePath: `refs/doc${i}.md`,
      workspacePath: `.webAgent/skills/many/SKILL.md/refs/doc${i}.md`,
    }))
    const result = buildProjectSkillEntry({
      dirName: 'many',
      origin: 'agent',
      scope: 'project',
      rootPath: '/workspace',
      filePath: '.webAgent/skills/many/SKILL.md',
      frontmatterRaw: validFrontmatter('many'),
      resourceFiles: files,
    })
    expect(result.entry).toBeDefined()
    expect(Object.keys(result.entry!.resources).length).toBe(MAX_PROJECT_RESOURCES_PER_SKILL)
    expect(result.diagnostics.some((d) => d.includes('资源数已超过上限'))).toBe(true)
  })

  it('claude 来源', () => {
    const result = buildProjectSkillEntry({
      dirName: 'legacy',
      origin: 'claude',
      scope: 'project',
      rootPath: '/workspace',
      filePath: '.claude/skills/legacy/SKILL.md',
      frontmatterRaw: validFrontmatter('legacy'),
      resourceFiles: [],
    })
    expect(result.entry!.origin).toBe('claude')
  })

  it('未知 frontmatter 键告警', () => {
    const raw = [
      '---',
      'name: test',
      'description: desc',
      'custom: something',
      '---',
    ].join('\n')
    const result = buildProjectSkillEntry({
      dirName: 'test',
      origin: 'agent',
      scope: 'project',
      rootPath: '/workspace',
      filePath: '.webAgent/skills/test/SKILL.md',
      frontmatterRaw: raw,
      resourceFiles: [],
    })
    expect(result.entry).toBeDefined()
    expect(result.diagnostics.some((d) => d.includes('custom'))).toBe(true)
  })

  it('triggers 里空字符串被过滤', () => {
    const raw = [
      '---',
      'name: test',
      'description: desc',
      'triggers: [deploy, , ci]',
      '---',
    ].join('\n')
    const result = buildProjectSkillEntry({
      dirName: 'test',
      origin: 'agent',
      scope: 'project',
      rootPath: '/workspace',
      filePath: '.webAgent/skills/test/SKILL.md',
      frontmatterRaw: raw,
      resourceFiles: [],
    })
    expect(result.entry!.triggers).toEqual(['deploy', 'ci'])
  })
})
