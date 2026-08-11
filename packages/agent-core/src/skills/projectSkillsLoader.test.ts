import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createCoreInstance, type CoreInstance, type ProjectSkillsLoaderBridge } from '../runtime/core/coreInstance'
import { scanProjectSkills } from './projectSkillsLoader'
import { projectSkillsAtom } from '../state/rootAtoms'

// ===========================================================================
// 辅助：fake bridge 工厂
// ===========================================================================

interface FakeFsEntry {
  path: string
  type: 'file' | 'directory'
}

interface FakeFile {
  content: string
}

function makeFakeBridge(
  entriesProvider: (path: string) => FakeFsEntry[],
  filesProvider: (path: string) => FakeFile | undefined,
): ProjectSkillsLoaderBridge {
  return {
    async listFiles(dirPath, opts) {
      const unfiltered = entriesProvider(dirPath)
      // 只返回在指定目录下的条目
      const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`
      return {
        entries: unfiltered.filter((e) => e.path.startsWith(prefix)),
      }
    },
    async readFile(filePath) {
      const file = filesProvider(filePath)
      if (!file) throw new Error(`ENOENT: ${filePath}`)
      return { content: file.content }
    },
  }
}

// ===========================================================================
// 常用 fake 文件系统
// ===========================================================================

function basicFakeFiles(): { entries: FakeFsEntry[]; files: Record<string, FakeFile> } {
  const entries: FakeFsEntry[] = [
    { path: '.webAgent/skills/deploy-flow', type: 'directory' },
    { path: '.webAgent/skills/deploy-flow/SKILL.md', type: 'file' },
    { path: '.webAgent/skills/deploy-flow/references/checklist.md', type: 'file' },
    { path: '.webAgent/skills/test-runner', type: 'directory' },
    { path: '.webAgent/skills/test-runner/SKILL.md', type: 'file' },
    { path: '.claude/skills/legacy-skill', type: 'directory' },
    { path: '.claude/skills/legacy-skill/SKILL.md', type: 'file' },
  ]

  const files: Record<string, FakeFile> = {
    '.webAgent/skills/deploy-flow/SKILL.md': {
      content: [
        '---',
        'name: deploy-flow',
        'description: 何时用：改发布脚本；何时不用：普通改动',
        'triggers: [deploy, 发布]',
        '---',
        '',
        '# 部署流程',
      ].join('\n'),
    },
    '.webAgent/skills/deploy-flow/references/checklist.md': {
      content: '# 检查清单\n- [ ] 测试通过\n- [ ] 构建通过',
    },
    '.webAgent/skills/test-runner/SKILL.md': {
      content: [
        '---',
        'name: test-runner',
        'description: 何时用：跑测试相关；何时不用：普通改动',
        '---',
        '',
        '# 测试运行器',
      ].join('\n'),
    },
    '.claude/skills/legacy-skill/SKILL.md': {
      content: [
        '---',
        'name: legacy-skill',
        'description: 何时用：旧版兼容流程；何时不用：新版流程',
        '---',
        '',
        '# 旧版 skill',
      ].join('\n'),
    },
  }

  return { entries, files }
}

function bridgeFromFake(fake: { entries: FakeFsEntry[]; files: Record<string, FakeFile> }): ProjectSkillsLoaderBridge {
  return makeFakeBridge(
    (path) => fake.entries,
    (path) => fake.files[path],
  )
}

// ===========================================================================
// 测试
// ===========================================================================

describe('projectSkillsLoader', () => {
  let core: CoreInstance

  beforeEach(() => {
    core = createCoreInstance()
  })

  // --- 无 bridge（web 端）---

  it('无 bridge 时 ensure 返回空快照（web 端恒空）', async () => {
    const snapshot = await core.projectSkills.ensure('/test')
    expect(snapshot.entries).toEqual([])
    expect(snapshot.diagnostics).toEqual([])
    expect(snapshot.workspaceRoot).toBe('/test')
  })

  it('无 bridge 时 refresh 返回空快照', async () => {
    const snapshot = await core.projectSkills.refresh('/test')
    expect(snapshot.entries).toEqual([])
  })

  // --- 缓存命中 ---

  it('命中缓存不重复 IO', async () => {
    const { entries, files } = basicFakeFiles()
    const bridge = bridgeFromFake({ entries, files })

    // 第一次：走真实扫描
    const snapshot1 = await core.projectSkills.ensure('/ws', bridge)
    expect(snapshot1.entries.length).toBeGreaterThan(0)

    // 第二次：同一 workspaceRoot，走缓存
    const snapshot2 = await core.projectSkills.ensure('/ws', bridge)
    expect(snapshot2).toBe(snapshot1) // 同引用（缓存命中）
  })

  it('不同 workspaceRoot 不共享缓存', async () => {
    const { entries, files } = basicFakeFiles()
    const bridge = bridgeFromFake({ entries, files })

    const snapshot1 = await core.projectSkills.ensure('/ws1', bridge)
    const snapshot2 = await core.projectSkills.ensure('/ws2', bridge)
    expect(snapshot1).not.toBe(snapshot2)
    expect(snapshot1.workspaceRoot).toBe('/ws1')
    expect(snapshot2.workspaceRoot).toBe('/ws2')
  })

  // --- 扫描结果 ---

  it('扫描 .webAgent 和 .claude 两路', async () => {
    const { entries, files } = basicFakeFiles()
    const bridge = bridgeFromFake({ entries, files })

    const snapshot = await core.projectSkills.ensure('/ws', bridge)
    // deploy-flow + test-runner + legacy-skill = 3
    expect(snapshot.entries).toHaveLength(3)
    const names = snapshot.entries.map((e) => e.name)
    expect(names).toContain('project/deploy-flow')
    expect(names).toContain('project/test-runner')
    expect(names).toContain('project/legacy-skill')
  })

  it('project/ 前缀正确添加', async () => {
    const { entries, files } = basicFakeFiles()
    const bridge = bridgeFromFake({ entries, files })

    const snapshot = await core.projectSkills.ensure('/ws', bridge)
    for (const entry of snapshot.entries) {
      expect(entry.name).toMatch(/^project\//)
    }
  })

  it('.webAgent 与 .claude 撞名 → .webAgent 胜', async () => {
    const entries: FakeFsEntry[] = [
      { path: '.webAgent/skills/my-skill', type: 'directory' },
      { path: '.webAgent/skills/my-skill/SKILL.md', type: 'file' },
      { path: '.claude/skills/my-skill', type: 'directory' },
      { path: '.claude/skills/my-skill/SKILL.md', type: 'file' },
    ]
    const files: Record<string, FakeFile> = {
      '.webAgent/skills/my-skill/SKILL.md': {
        content: '---\nname: my-skill\ndescription: agent version\n---\n',
      },
      '.claude/skills/my-skill/SKILL.md': {
        content: '---\nname: my-skill\ndescription: claude version\n---\n',
      },
    }
    const bridge = bridgeFromFake({ entries, files })

    const snapshot = await core.projectSkills.ensure('/ws', bridge)
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0].origin).toBe('agent')
    expect(snapshot.entries[0].description).toBe('agent version')
    expect(snapshot.diagnostics.some((d) => d.includes('.webAgent 同名'))).toBe(true)
  })

  // --- 降级场景 ---

  it('.webAgent 目录不存在 → 只返回 .claude 的结果', async () => {
    const entries: FakeFsEntry[] = [
      { path: '.claude/skills/only-skill', type: 'directory' },
      { path: '.claude/skills/only-skill/SKILL.md', type: 'file' },
    ]
    const files: Record<string, FakeFile> = {
      '.claude/skills/only-skill/SKILL.md': {
        content: '---\nname: only-skill\ndescription: the only skill\n---\n',
      },
    }
    const bridge = bridgeFromFake({ entries, files })

    const snapshot = await core.projectSkills.ensure('/ws', bridge)
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0].name).toBe('project/only-skill')
  })

  it('listFiles 报错 → 该路降级为空', async () => {
    const bridge: ProjectSkillsLoaderBridge = {
      async listFiles() {
        throw new Error('Permission denied')
      },
      async readFile() {
        throw new Error('should not be called')
      },
    }

    const snapshot = await core.projectSkills.ensure('/ws', bridge)
    expect(snapshot.entries).toEqual([])
    expect(snapshot.diagnostics.some((d) => d.includes('列表失败'))).toBe(true)
  })

  it('单个 SKILL.md 读失败 → 该 skill 跳过、其它照常', async () => {
    const entries: FakeFsEntry[] = [
      { path: '.webAgent/skills/good-skill', type: 'directory' },
      { path: '.webAgent/skills/good-skill/SKILL.md', type: 'file' },
      { path: '.webAgent/skills/bad-skill', type: 'directory' },
      { path: '.webAgent/skills/bad-skill/SKILL.md', type: 'file' },
    ]
    const files: Record<string, FakeFile> = {
      '.webAgent/skills/good-skill/SKILL.md': {
        content: '---\nname: good-skill\ndescription: works fine\n---\n',
      },
      // bad-skill 的文件不存在 → readFile 失败
    }
    const bridge = bridgeFromFake({ entries, files })

    const snapshot = await core.projectSkills.ensure('/ws', bridge)
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0].name).toBe('project/good-skill')
    expect(snapshot.diagnostics.some((d) => d.includes('bad-skill') && d.includes('ENOENT'))).toBe(true)
  })

  it('readFile 读超过 4KB 仍然返回完整内容（截断由 bridge 侧做）', async () => {
    const longFrontmatter = [
      '---',
      `description: "${'a'.repeat(200)}"`,
      '---',
      '',
      'x'.repeat(10000),
    ].join('\n')
    const entries: FakeFsEntry[] = [
      { path: '.webAgent/skills/huge', type: 'directory' },
      { path: '.webAgent/skills/huge/SKILL.md', type: 'file' },
    ]
    const files: Record<string, FakeFile> = {
      '.webAgent/skills/huge/SKILL.md': { content: longFrontmatter },
    }
    const bridge = bridgeFromFake({ entries, files })

    // 即使文件很大，桥层面限制到 4KB 应由调用方处理
    const snapshot = await core.projectSkills.refresh('/ws', bridge)
    // description 被 sanitize 截断到 160
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0].description).toHaveLength(161)
    expect(snapshot.entries[0].description.endsWith('…')).toBe(true)
  })

  // --- refresh / clear ---

  it('refresh 后重新扫描（无视缓存）', async () => {
    // 第一次扫描：1 个 skill
    const entries1: FakeFsEntry[] = [
      { path: '.webAgent/skills/alpha', type: 'directory' },
      { path: '.webAgent/skills/alpha/SKILL.md', type: 'file' },
    ]
    const files1: Record<string, FakeFile> = {
      '.webAgent/skills/alpha/SKILL.md': {
        content: '---\nname: alpha\ndescription: first\n---\n',
      },
    }
    const bridge1 = bridgeFromFake({ entries: entries1, files: files1 })

    const snapshot1 = await core.projectSkills.ensure('/ws', bridge1)
    expect(snapshot1.entries).toHaveLength(1)

    // 替换桥：模拟文件系统变化（新增一个 skill）
    const entries2: FakeFsEntry[] = [
      ...entries1,
      { path: '.webAgent/skills/beta', type: 'directory' },
      { path: '.webAgent/skills/beta/SKILL.md', type: 'file' },
    ]
    const files2: Record<string, FakeFile> = {
      ...files1,
      '.webAgent/skills/beta/SKILL.md': {
        content: '---\nname: beta\ndescription: second\n---\n',
      },
    }
    const bridge2 = bridgeFromFake({ entries: entries2, files: files2 })

    // ensure 命中缓存：还是 1 个
    const snapshot2 = await core.projectSkills.ensure('/ws', bridge2)
    expect(snapshot2.entries).toHaveLength(1)

    // refresh 无视缓存：现在 2 个
    const snapshot3 = await core.projectSkills.refresh('/ws', bridge2)
    expect(snapshot3.entries).toHaveLength(2)
  })

  it('clear 后缓存清空', async () => {
    const { entries, files } = basicFakeFiles()
    const bridge = bridgeFromFake({ entries, files })

    const snapshot1 = await core.projectSkills.ensure('/ws', bridge)
    expect(snapshot1.entries.length).toBeGreaterThan(0)

    core.projectSkills.clear('/ws')

    // 缓存已清，get 返回 undefined
    expect(core.projectSkills.get('/ws')).toBeUndefined()

    // ensure 重新扫描
    const snapshot2 = await core.projectSkills.ensure('/ws', bridge)
    expect(snapshot2.entries.length).toBeGreaterThan(0)
    expect(snapshot2).not.toBe(snapshot1) // 不同引用（新扫描结果）
  })

  // --- 边缘情况 ---

  it('无任何 SKILL.md → 空快照', async () => {
    const entries: FakeFsEntry[] = [
      // 没有 skills 目录
    ]
    const bridge = bridgeFromFake({ entries, files: {} })

    const snapshot = await core.projectSkills.ensure('/ws', bridge)
    expect(snapshot.entries).toEqual([])
    expect(snapshot.diagnostics).toEqual([])
  })

  it('深度 > 1 的 SKILL.md 被忽略', async () => {
    const entries: FakeFsEntry[] = [
      { path: '.webAgent/skills/top-level', type: 'directory' },
      { path: '.webAgent/skills/top-level/SKILL.md', type: 'file' },
      // 这个在嵌套子目录里，应该被忽略
      { path: '.webAgent/skills/top-level/sub-dir', type: 'directory' },
      { path: '.webAgent/skills/top-level/sub-dir/SKILL.md', type: 'file' },
    ]
    const files: Record<string, FakeFile> = {
      '.webAgent/skills/top-level/SKILL.md': {
        content: '---\nname: top\ndescription: only top-level recognized\n---\n',
      },
      '.webAgent/skills/top-level/sub-dir/SKILL.md': {
        content: '---\nname: nested\ndescription: should be ignored\n---\n',
      },
    }
    const bridge = bridgeFromFake({ entries, files })

    const snapshot = await core.projectSkills.ensure('/ws', bridge)
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0].name).toBe('project/top')
  })

  it('多个 core 实例互相隔离', async () => {
    const core1 = createCoreInstance()
    const core2 = createCoreInstance()

    const { entries, files } = basicFakeFiles()
    const bridge = bridgeFromFake({ entries, files })

    const snap1 = await core1.projectSkills.ensure('/ws', bridge)
    const snap2 = await core2.projectSkills.ensure('/ws', bridge)

    // 两个实例各自独立扫描（不在共享缓存中）
    expect(snap1).not.toBe(snap2)
    // 但结果应该相同
    expect(snap1.entries.length).toBe(snap2.entries.length)
  })

  it('scanProjectSkills 整体异常降级为快照（bridge 抛未捕获错误）', async () => {
    // 使用一个在 listFiles 失败后仍然由 scanProjectSkills 的 resolveProjectSkills 收口的场景
    // 这里两路 listFiles 都会失败
    const bridge: ProjectSkillsLoaderBridge = {
      async listFiles() { throw new Error('EPERM') },
      async readFile() { throw new Error('should not be called') },
    }

    const snapshot = await core.projectSkills.refresh('/ws', bridge)
    expect(snapshot.entries).toEqual([])
    // 两路都失败，diagnostics 应该有两条
    expect(snapshot.diagnostics.filter((d) => d.includes('列表失败'))).toHaveLength(2)
  })
})

describe('scanProjectSkills · 目录缺失与错误保真（review 修复回归护栏）', () => {
  it('两个根都不存在 → 空快照且【无】diagnostics（多数仓库的常态，不该刷噪声）', async () => {
    const bridge = {
      listFiles: vi.fn(async (path: string) => {
        throw new Error(`path \`${path}\` is not accessible: No such file or directory (os error 2)`)
      }),
      readFile: vi.fn(),
    }
    const snapshot = await scanProjectSkills('/w', bridge as never)
    expect(snapshot.entries).toEqual([])
    expect(snapshot.diagnostics).toEqual([])
  })

  it('列目录因其它原因失败 → 记 diagnostics 并保留原始错误文本', async () => {
    const bridge = {
      listFiles: vi.fn(async () => {
        throw new Error('permission denied')
      }),
      readFile: vi.fn(),
    }
    const snapshot = await scanProjectSkills('/w', bridge as never)
    expect(snapshot.diagnostics.join('\n')).toContain('.webAgent/skills: 列表失败 — permission denied')
  })

  it('一个根缺失不影响另一个根被扫到', async () => {
    const bridge = {
      listFiles: vi.fn(async (path: string) => {
        if (path === '.webAgent/skills') throw new Error('path is not accessible')
        return {
          entries: [
            { path: '.claude/skills/legacy/SKILL.md', type: 'file' },
          ],
        }
      }),
      readFile: vi.fn(async () => ({ content: '---\nname: legacy\ndescription: 兼容读取\n---\n正文\n' })),
    }
    const snapshot = await scanProjectSkills('/w', bridge as never)
    expect(snapshot.entries.map((entry) => entry.name)).toEqual(['project/legacy'])
    expect(snapshot.diagnostics).toEqual([])
  })

  it('单个 SKILL.md 读失败只跳过它自己，其余照常加载', async () => {
    const bridge = {
      listFiles: vi.fn(async (path: string) => {
        if (path !== '.webAgent/skills') return { entries: [] }
        return {
          entries: [
            { path: '.webAgent/skills/good/SKILL.md', type: 'file' },
            { path: '.webAgent/skills/bad/SKILL.md', type: 'file' },
          ],
        }
      }),
      readFile: vi.fn(async (path: string) => {
        if (path.includes('/bad/')) throw new Error('EISDIR')
        return { content: '---\nname: good\ndescription: 可用\n---\n正文\n' }
      }),
    }
    const snapshot = await scanProjectSkills('/w', bridge as never)
    expect(snapshot.entries.map((entry) => entry.name)).toEqual(['project/good'])
    expect(snapshot.diagnostics.join('\n')).toContain('.webAgent/skills/bad: 读取 SKILL.md 失败')
  })

  it('深层 SKILL.md（非扫描根的直接子目录）静默跳过，不记为异常', async () => {
    const bridge = {
      listFiles: vi.fn(async (path: string) => (path === '.webAgent/skills'
        ? { entries: [{ path: '.webAgent/skills/a/examples/b/SKILL.md', type: 'file' }] }
        : { entries: [] })),
      readFile: vi.fn(),
    }
    const snapshot = await scanProjectSkills('/w', bridge as never)
    expect(snapshot.entries).toEqual([])
    expect(snapshot.diagnostics).toEqual([])
    expect(bridge.listFiles.mock.calls.map(([path]) => path))
      .toEqual(['.webAgent/skills', '.claude/skills'])
    expect(bridge.readFile).not.toHaveBeenCalled()
  })
})

describe('CoreInstance.projectSkills · 快照存 atom + in-flight 去重（review 修复）', () => {
  it('快照写进 rootStore 的 projectSkillsAtom —— UI 因此可订阅', async () => {
    const core = createCoreInstance()
    const bridge: ProjectSkillsLoaderBridge = {
      listFiles: async (path) => (path === '.webAgent/skills'
        ? { entries: [{ path: '.webAgent/skills/x/SKILL.md', type: 'file' }] }
        : { entries: [] }),
      readFile: async () => ({ content: '---\nname: x\ndescription: 描述\n---\n正文\n' }),
    }
    await core.projectSkills.ensure('/w', bridge)
    expect(core.rootStore.getter(projectSkillsAtom)['/w'].entries.map((entry) => entry.name))
      .toEqual(['project/x'])
    expect(core.projectSkills.get('/w')).toBe(core.rootStore.getter(projectSkillsAtom)['/w'])
  })

  it('同一 workspace 的并发 ensure 只扫一次', async () => {
    const core = createCoreInstance()
    let listCalls = 0
    const bridge: ProjectSkillsLoaderBridge = {
      listFiles: async () => {
        listCalls += 1
        await Promise.resolve()
        return { entries: [] }
      },
      readFile: async () => ({ content: '' }),
    }
    await Promise.all([
      core.projectSkills.ensure('/w', bridge),
      core.projectSkills.ensure('/w', bridge),
      core.projectSkills.ensure('/w', bridge),
    ])
    // 两个扫描根各一次 list，且整体只发生一轮扫描（而不是三轮）
    expect(listCalls).toBe(2)
  })

  it('扫描器整体抛错 → 降级为空快照 + 一条 diagnostics，绝不冒泡到 run', async () => {
    const core = createCoreInstance()
    const bridge = {
      listFiles: () => { throw new Error('bridge exploded') },
      readFile: async () => ({ content: '' }),
    } as unknown as ProjectSkillsLoaderBridge
    const snapshot = await core.projectSkills.ensure('/w', bridge)
    expect(snapshot.entries).toEqual([])
    // listFiles 同步抛在 scanRoot 的 try 内被接住 → 记成该根的列表失败，仍是可解释的降级
    expect(snapshot.diagnostics.length).toBeGreaterThan(0)
  })

  it('无 bridge（web 端）→ 空快照；clear 后回到未扫描态', async () => {
    const core = createCoreInstance()
    const snapshot = await core.projectSkills.ensure('/w', undefined)
    expect(snapshot.entries).toEqual([])
    expect(core.projectSkills.get('/w')).toBeDefined()
    core.projectSkills.clear('/w')
    expect(core.projectSkills.get('/w')).toBeUndefined()
  })

  it('两个 core 的快照互不串台（隔离性）', async () => {
    const a = createCoreInstance()
    const b = createCoreInstance()
    await a.projectSkills.ensure('/w', undefined)
    expect(a.projectSkills.get('/w')).toBeDefined()
    expect(b.projectSkills.get('/w')).toBeUndefined()
  })
})
