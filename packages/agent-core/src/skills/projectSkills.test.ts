import { describe, it, expect } from 'vitest'
import {
  parseFrontmatter,
  sanitizeName,
  sanitizeDescription,
  buildProjectSkillEntry,
  resolveProjectSkills,
  emptyProjectSkillsSnapshot,
  MAX_PROJECT_SKILLS,
  MAX_PROJECT_RESOURCES_PER_SKILL,
  type ProjectSkillEntry,
  type ProjectSkillsSnapshot,
} from './projectSkills'
import { buildSkillManifestText } from './registry'

// ===========================================================================
// 基线：记录当前 buildSkillManifestText() 无参调用的输出，作为回归护栏
// ===========================================================================

const BASELINE_MANIFEST = buildSkillManifestText()

function baselineLines(): string[] {
  return BASELINE_MANIFEST.split('\n')
}

// ===========================================================================
// parseFrontmatter
// ===========================================================================

describe('parseFrontmatter', () => {
  it('空字符串 → 所有字段默认值', () => {
    const fm = parseFrontmatter('')
    expect(fm.name).toBeUndefined()
    expect(fm.description).toBeUndefined()
    expect(fm.triggers).toBeUndefined()
    expect(fm.unknownKeys).toEqual([])
  })

  it('不以 --- 开头的文本 → 所有字段默认值', () => {
    const fm = parseFrontmatter('hello world')
    expect(fm.name).toBeUndefined()
    expect(fm.description).toBeUndefined()
    expect(fm.unknownKeys).toEqual([])
  })

  it('标准 frontmatter 三项齐全', () => {
    const raw = [
      '---',
      'name: deploy-flow',
      'description: 何时用：改发布脚本；何时不用：普通改动',
      'triggers: [deploy, 发布, 上线]',
      '---',
      '',
      '# 正文开始',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBe('deploy-flow')
    expect(fm.description).toBe('何时用：改发布脚本；何时不用：普通改动')
    expect(fm.triggers).toEqual(['deploy', '发布', '上线'])
    expect(fm.unknownKeys).toEqual([])
  })

  it('name 来自 frontmatter（覆盖目录名）', () => {
    const raw = [
      '---',
      'name: custom-name',
      '---',
      '',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBe('custom-name')
  })

  it('name 缺失 → undefined', () => {
    const raw = [
      '---',
      'description: 只有描述',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBeUndefined()
    expect(fm.description).toBe('只有描述')
  })

  it('description 缺失 → undefined', () => {
    const raw = [
      '---',
      'name: some-skill',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBe('some-skill')
    expect(fm.description).toBeUndefined()
  })

  it('triggers 空数组', () => {
    const raw = [
      '---',
      'name: no-triggers',
      'description: 无触发词',
      'triggers: []',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.triggers).toEqual([])
  })

  it('triggers 缺失 → undefined', () => {
    const raw = [
      '---',
      'name: no-triggers',
      'description: 无触发词',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.triggers).toBeUndefined()
  })

  it('未知键 → 记录到 unknownKeys', () => {
    const raw = [
      '---',
      'name: test',
      'description: desc',
      'version: 1.0',
      'author: someone',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.unknownKeys).toEqual(['version', 'author'])
  })

  it('语法不合法的行 → 记录到 unknownKeys', () => {
    const raw = [
      '---',
      'no colon here',
      'name: test',
      'description: desc',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBe('test')
    expect(fm.description).toBe('desc')
    expect(fm.unknownKeys).toContain('(malformed line) no colon here')
  })

  it('只识别开头的 frontmatter，正文中的 --- 不被识别为结束', () => {
    const raw = [
      '---',
      'name: test',
      'description: desc',
      '---',
      '',
      '# 正文',
      '正文中有一段 --- 但不是围栏',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBe('test')
    expect(fm.description).toBe('desc')
  })

  it('有开头围栏但无结束围栏 → 所有字段默认值', () => {
    const raw = [
      '---',
      'name: ghost-skill',
      'description: missing closing fence',
      '',
      '# no --- ahead',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBeUndefined()
    expect(fm.description).toBeUndefined()
    expect(fm.unknownKeys).toEqual([])
  })

  it('description 用双引号包裹', () => {
    const raw = [
      '---',
      'name: quoted',
      'description: "包含: 特殊字符"',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.description).toBe('包含: 特殊字符')
  })

  it('description 用单引号包裹', () => {
    const raw = [
      '---',
      "name: quoted",
      "description: '包含: 特殊字符'",
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.description).toBe('包含: 特殊字符')
  })

  it('triggers 数组中含引号包裹的项', () => {
    const raw = [
      '---',
      'name: test',
      'description: desc',
      'triggers: ["deploy", \'发布\', simple]',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.triggers).toEqual(['deploy', '发布', 'simple'])
  })

  it('CRLF 换行符', () => {
    const raw = '---\r\nname: crlf\r\ndescription: with crlf\r\n---\r\n'
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBe('crlf')
    expect(fm.description).toBe('with crlf')
  })

  it('空 frontmatter（两个紧邻的 ---）', () => {
    const raw = ['---', '---', ''].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBeUndefined()
    expect(fm.description).toBeUndefined()
    expect(fm.triggers).toBeUndefined()
    expect(fm.unknownKeys).toEqual([])
  })

  it('description 含有注释（# 之后被忽略）', () => {
    const raw = ['---', 'description: 有用描述 # 这是注释', '---', ''].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.description).toBe('有用描述')
  })
})

// ===========================================================================
// sanitizeName
// ===========================================================================

describe('sanitizeName', () => {
  it('合法小写字母+数字+短横线', () => {
    expect(sanitizeName('deploy-flow')).toBe('deploy-flow')
    expect(sanitizeName('test123')).toBe('test123')
    expect(sanitizeName('a')).toBe('a')
  })

  it('自动转小写', () => {
    expect(sanitizeName('Deploy-Flow')).toBe('deploy-flow')
  })

  it('trim 前后空格', () => {
    expect(sanitizeName('  my-skill  ')).toBe('my-skill')
  })

  it('非法：含下划线 → undefined', () => {
    expect(sanitizeName('deploy_flow')).toBeUndefined()
  })

  it('非法：含点 → undefined', () => {
    expect(sanitizeName('deploy.flow')).toBeUndefined()
  })

  it('非法：含空格 → undefined', () => {
    expect(sanitizeName('deploy flow')).toBeUndefined()
  })

  it('非法：以短横线开头 → undefined', () => {
    expect(sanitizeName('-start')).toBeUndefined()
  })

  it('非法：空字符串 → undefined', () => {
    expect(sanitizeName('')).toBeUndefined()
  })

  it('非法：超过 64 字符 → undefined', () => {
    expect(sanitizeName('a'.repeat(65))).toBeUndefined()
  })

  it('边界：正好 64 字符 → 合法', () => {
    expect(sanitizeName('a'.repeat(64))).toBe('a'.repeat(64))
  })
})

// ===========================================================================
// sanitizeDescription
// ===========================================================================

describe('sanitizeDescription', () => {
  it('正常描述原样返回，不标记截断', () => {
    const desc = '何时用：改发布脚本时读我；何时不用：普通改动'
    expect(sanitizeDescription(desc)).toEqual({ value: desc, truncated: false })
  })

  it('剥离控制字符', () => {
    expect(sanitizeDescription('hello\x00world')?.value).toBe('helloworld')
    expect(sanitizeDescription('test\x1Bcontrol')?.value).toBe('testcontrol')
    expect(sanitizeDescription('normal\x7Fdel')?.value).toBe('normaldel')
  })

  it('多行 → 只取第一行', () => {
    const desc = '第一行描述\n第二行不应该出现\n第三行'
    expect(sanitizeDescription(desc)?.value).toBe('第一行描述')
  })

  it('超长 → 截断到 160 字符并追加省略号 + 标记 truncated', () => {
    const long = 'x'.repeat(200)
    const result = sanitizeDescription(long)
    // 省略号是给模型的信号：这句话没说完，别把它当完整约束读
    expect(result).toEqual({ value: `${'x'.repeat(160)}…`, truncated: true })
  })

  it('边界：正好 160 字符 → 原样返回，不加省略号', () => {
    const exact = 'x'.repeat(160)
    expect(sanitizeDescription(exact)).toEqual({ value: exact, truncated: false })
  })

  it('卫生化后为空 → undefined', () => {
    expect(sanitizeDescription('')).toBeUndefined()
    expect(sanitizeDescription('   ')).toBeUndefined()
    expect(sanitizeDescription('\n\n')).toBeUndefined()
  })

  it('只有控制字符 → undefined', () => {
    expect(sanitizeDescription('\x00\x01\x02')).toBeUndefined()
  })

  it('保留中文、标点与常见符号', () => {
    const desc = '何时用：发布/上线/CI 相关时读我；何时不用：普通编辑。'
    expect(sanitizeDescription(desc)?.value).toBe(desc)
  })
})

// ===========================================================================
// buildProjectSkillEntry
// ===========================================================================

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
      filePath: '.webAgent/skills/test/SKILL.md',
      frontmatterRaw: raw,
      resourceFiles: [],
    })
    expect(result.entry!.triggers).toEqual(['deploy', 'ci'])
  })
})

// ===========================================================================
// resolveProjectSkills
// ===========================================================================

describe('resolveProjectSkills', () => {
  function makeEntry(name: string, origin: 'agent' | 'claude' = 'agent'): ProjectSkillEntry {
    return {
      name: `project/${name}`,
      description: `description for ${name}`,
      triggers: [],
      filePath: origin === 'agent' ? `.webAgent/skills/${name}/SKILL.md` : `.claude/skills/${name}/SKILL.md`,
      resources: {},
      origin,
    }
  }

  it('空输入 → 空快照', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      agentEntries: [],
      agentDiagnostics: [],
      claudeEntries: [],
      claudeDiagnostics: [],
    })
    expect(snapshot.entries).toEqual([])
    expect(snapshot.diagnostics).toEqual([])
    expect(snapshot.workspaceRoot).toBe('/test')
  })

  it('.webAgent 与 .claude 撞名 → .webAgent 胜', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      agentEntries: [makeEntry('deploy', 'agent')],
      agentDiagnostics: [],
      claudeEntries: [makeEntry('deploy', 'claude')],
      claudeDiagnostics: [],
    })
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0].origin).toBe('agent')
    expect(snapshot.diagnostics.some((d) => d.includes('.webAgent 同名') && d.includes('claude'))).toBe(true)
  })

  it('不撞名时两路合并', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      agentEntries: [makeEntry('deploy', 'agent')],
      agentDiagnostics: [],
      claudeEntries: [makeEntry('legacy', 'claude')],
      claudeDiagnostics: [],
    })
    expect(snapshot.entries).toHaveLength(2)
  })

  it('按名字字节序排序', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      agentEntries: [
        makeEntry('zebra', 'agent'),
        makeEntry('alpha', 'agent'),
        makeEntry('mike', 'claude'),
      ],
      agentDiagnostics: [],
      claudeEntries: [],
      claudeDiagnostics: [],
    })
    const names = snapshot.entries.map((e) => e.name)
    expect(names).toEqual(['project/alpha', 'project/mike', 'project/zebra'])
  })

  it('超过 MAX_PROJECT_SKILLS 截断', () => {
    const entries = Array.from({ length: MAX_PROJECT_SKILLS + 5 }, (_, i) =>
      makeEntry(`skill-${String(i).padStart(3, '0')}`, 'agent'),
    )
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      agentEntries: entries,
      agentDiagnostics: [],
      claudeEntries: [],
      claudeDiagnostics: [],
    })
    expect(snapshot.entries).toHaveLength(MAX_PROJECT_SKILLS)
    expect(snapshot.diagnostics.some((d) => d.includes('超过上限'))).toBe(true)
  })

  it('diagnostics 合并', () => {
    const snapshot = resolveProjectSkills({
      workspaceRoot: '/test',
      agentEntries: [],
      agentDiagnostics: ['agent warning'],
      claudeEntries: [],
      claudeDiagnostics: ['claude warning'],
    })
    expect(snapshot.diagnostics).toContain('agent warning')
    expect(snapshot.diagnostics).toContain('claude warning')
  })
})

// ===========================================================================
// emptyProjectSkillsSnapshot
// ===========================================================================

describe('emptyProjectSkillsSnapshot', () => {
  it('构造一个空快照', () => {
    const snapshot = emptyProjectSkillsSnapshot('/test')
    expect(snapshot.workspaceRoot).toBe('/test')
    expect(snapshot.entries).toEqual([])
    expect(snapshot.diagnostics).toEqual([])
  })
})

// ===========================================================================
// buildSkillManifestText 与快照的交互
// ===========================================================================

describe('buildSkillManifestText 项目段', () => {
  function makeSnapshot(entries: ProjectSkillEntry[]): ProjectSkillsSnapshot {
    return {
      workspaceRoot: '/test',
      entries,
      diagnostics: [],
    }
  }

  it('无参调用 → 与基线逐字相同（web 端零回归）', () => {
    const current = buildSkillManifestText()
    expect(current).toBe(BASELINE_MANIFEST)
  })

  it('undefined 入参 → 与基线逐字相同', () => {
    expect(buildSkillManifestText(undefined)).toBe(BASELINE_MANIFEST)
  })

  it('空快照 → 与基线逐字相同', () => {
    expect(buildSkillManifestText(makeSnapshot([]))).toBe(BASELINE_MANIFEST)
  })

  it('有空快照两次调用一致（字节稳定）', () => {
    const a = buildSkillManifestText(makeSnapshot([]))
    const b = buildSkillManifestText(makeSnapshot([]))
    expect(a).toBe(b)
  })

  it('带项目 skill 的快照 → 出现项目段', () => {
    const entry: ProjectSkillEntry = {
      name: 'project/deploy-flow',
      description: '何时用：改发布脚本时读我；何时不用：普通改动',
      triggers: [],
      filePath: '.webAgent/skills/deploy-flow/SKILL.md',
      resources: {},
      origin: 'agent',
    }
    const manifest = buildSkillManifestText(makeSnapshot([entry]))
    expect(manifest).toContain('以下由当前 workspace 提供')
    expect(manifest).toContain('project/deploy-flow')
    // 依然包含抬头和内置 skills
    expect(manifest).toContain('skill_read')
    expect(manifest).toContain('planning')
  })

  it('项目段在内置段之后', () => {
    const entry: ProjectSkillEntry = {
      name: 'project/test',
      description: '测试 skill',
      triggers: [],
      filePath: '.webAgent/skills/test/SKILL.md',
      resources: {},
      origin: 'agent',
    }
    const manifest = buildSkillManifestText(makeSnapshot([entry]))
    const projectIndex = manifest.indexOf('以下由当前 workspace 提供')
    const builtinIndex = manifest.indexOf('skill_read')
    expect(projectIndex).toBeGreaterThan(builtinIndex)
  })

  it('多个项目 skill 按名字字节序排列', () => {
    const entries: ProjectSkillEntry[] = [
      {
        name: 'project/zebra',
        description: 'z desc',
        triggers: [],
        filePath: '.webAgent/skills/zebra/SKILL.md',
        resources: {},
        origin: 'agent',
      },
      {
        name: 'project/alpha',
        description: 'a desc',
        triggers: [],
        filePath: '.webAgent/skills/alpha/SKILL.md',
        resources: {},
        origin: 'agent',
      },
    ]
    const manifest = buildSkillManifestText(makeSnapshot(entries))
    const lines = manifest.split('\n')
    const projectSectionStart = lines.findIndex((l) => l.includes('以下由当前 workspace'))
    const projectLines = lines.slice(projectSectionStart + 1)
    // alpha 应该在 zebra 之前
    expect(projectLines[0]).toContain('project/alpha')
    expect(projectLines[1]).toContain('project/zebra')
  })

  it('有项目段时两次调用一致', () => {
    const entry: ProjectSkillEntry = {
      name: 'project/test',
      description: '测试 skill',
      triggers: [],
      filePath: '.webAgent/skills/test/SKILL.md',
      resources: {},
      origin: 'agent',
    }
    const snapshot = makeSnapshot([entry])
    expect(buildSkillManifestText(snapshot)).toBe(buildSkillManifestText(snapshot))
  })
})
