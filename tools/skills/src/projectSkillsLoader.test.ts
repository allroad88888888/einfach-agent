import { describe, expect, it, vi } from 'vitest'
import {
  createCoreInstance,
  type ProjectSkillsLoaderBridge,
} from '@einfach-agent/core/runtime/core/coreInstance'
import { scanProjectSkills } from './projectSkillsLoader'

type FileEntry = { path: string; type: string }

function createBridge(
  entries: FileEntry[],
  files: Record<string, string>,
): ProjectSkillsLoaderBridge {
  return {
    async listFiles(path) {
      const prefix = `${path}/`
      return { entries: entries.filter((entry) => entry.path.startsWith(prefix)) }
    },
    async readFile(path) {
      const content = files[path]
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return { content }
    },
  }
}

const skill = (name: string, description: string) => [
  '---',
  `name: ${name}`,
  `description: ${description}`,
  'triggers: [deploy]',
  '---',
  '# 正文',
].join('\n')

describe('projectSkillsLoader', () => {
  it('扫描两套目录、收集资源并让 .webAgent 覆盖同名 .claude skill', async () => {
    const entries: FileEntry[] = [
      { path: '.webAgent/skills/deploy/SKILL.md', type: 'file' },
      { path: '.webAgent/skills/deploy/references/checklist.md', type: 'file' },
      { path: '.webAgent/skills/deploy/nested/SKILL.md', type: 'file' },
      { path: '.claude/skills/deploy/SKILL.md', type: 'file' },
      { path: '.claude/skills/legacy/SKILL.md', type: 'file' },
    ]
    const snapshot = await scanProjectSkills('/workspace', createBridge(entries, {
      '.webAgent/skills/deploy/SKILL.md': skill('deploy', 'agent 版本'),
      '.webAgent/skills/deploy/references/checklist.md': '# 检查清单',
      '.webAgent/skills/deploy/nested/SKILL.md': skill('nested', '不应扫描'),
      '.claude/skills/deploy/SKILL.md': skill('deploy', 'claude 版本'),
      '.claude/skills/legacy/SKILL.md': skill('legacy', '旧版流程'),
    }))

    expect(snapshot.entries.map((entry) => entry.name)).toEqual(['project/deploy', 'project/legacy'])
    expect(snapshot.entries[0]).toMatchObject({
      description: 'agent 版本',
      origin: 'agent',
      resources: { 'references/checklist.md': '.webAgent/skills/deploy/references/checklist.md' },
    })
    expect(snapshot.diagnostics.join('\n')).toContain('与 .webAgent/skills 同名')
  })

  it('缺少目录静默降级，其他目录列表与文件读取错误保留诊断', async () => {
    const bridge: ProjectSkillsLoaderBridge = {
      async listFiles(path) {
        if (path === '.webAgent/skills') throw new Error('path is not accessible: missing')
        return { entries: [{ path: '.claude/skills/broken/SKILL.md', type: 'file' }] }
      },
      async readFile() {
        throw new Error('permission denied')
      },
    }
    const snapshot = await scanProjectSkills('/workspace', bridge)

    expect(snapshot.entries).toEqual([])
    expect(snapshot.diagnostics).toEqual([
      '.claude/skills/broken: 读取 SKILL.md 失败 — permission denied，已跳过',
    ])
  })

  it('给了主目录就多扫一遍，条目走 user/ 前缀且路径相对主目录', async () => {
    // 按根分账的桥：两个根下各有一个同名目录，正是「路径相对哪个根」会出错的场景。
    const byRoot: Record<string, Record<string, string>> = {
      '/workspace': { '.claude/skills/deploy/SKILL.md': skill('deploy', '工作区版本') },
      '/home/me': { '.claude/skills/deploy/SKILL.md': skill('deploy', '主目录版本') },
    }
    const listCalls: Array<{ path: string; root: string }> = []
    const bridge: ProjectSkillsLoaderBridge = {
      async listFiles(path, options) {
        listCalls.push({ path, root: options.workspaceRoot })
        const files = byRoot[options.workspaceRoot] ?? {}
        const matched = Object.keys(files).filter((file) => file.startsWith(`${path}/`))
        if (matched.length === 0) throw new Error('path is not accessible: missing')
        return { entries: matched.map((file) => ({ path: file, type: 'file' })) }
      },
      async readFile(path, options) {
        const content = (byRoot[options.workspaceRoot] ?? {})[path]
        if (content === undefined) throw new Error(`ENOENT: ${path}`)
        return { content }
      },
    }

    const snapshot = await scanProjectSkills('/workspace', bridge, { userSkillsRoot: '/home/me' })

    expect(snapshot.entries.map((entry) => entry.name)).toEqual(['project/deploy', 'user/deploy'])
    expect(snapshot.entries[1]).toMatchObject({
      description: '主目录版本',
      scope: 'user',
      filePath: '.claude/skills/deploy/SKILL.md',
    })
    expect(snapshot.userSkillsRoot).toBe('/home/me')
    // 主目录那两路必须把主目录当根传给桥：传会话 workspace 会被 confinement 挡下。
    expect(listCalls).toContainEqual({ path: '.claude/skills', root: '/home/me' })
    expect(listCalls).toContainEqual({ path: '.webAgent/skills', root: '/home/me' })
  })

  it('不给主目录时只扫工作区（浏览器宿主的现状不回归）', async () => {
    const roots = new Set<string>()
    const bridge: ProjectSkillsLoaderBridge = {
      async listFiles(_path, options) {
        roots.add(options.workspaceRoot)
        throw new Error('path is not accessible: missing')
      },
      async readFile() {
        throw new Error('unreachable')
      },
    }

    const snapshot = await scanProjectSkills('/workspace', bridge)

    expect([...roots]).toEqual(['/workspace'])
    expect(snapshot.userSkillsRoot).toBeUndefined()
  })

  it('工作区就是主目录时不扫第二遍 —— 同一批文件不该占两份清单预算', async () => {
    const listCalls: string[] = []
    const bridge: ProjectSkillsLoaderBridge = {
      async listFiles(path) {
        listCalls.push(path)
        if (path !== '.claude/skills') throw new Error('path is not accessible: missing')
        return { entries: [{ path: '.claude/skills/deploy/SKILL.md', type: 'file' }] }
      },
      async readFile() {
        return { content: skill('deploy', '主目录即工作区') }
      },
    }

    const snapshot = await scanProjectSkills('/home/me', bridge, { userSkillsRoot: '/home/me' })

    expect(snapshot.entries.map((entry) => entry.name)).toEqual(['project/deploy'])
    expect(listCalls).toEqual(['.webAgent/skills', '.claude/skills'])
    expect(snapshot.userSkillsRoot).toBeUndefined()
  })

  it('符号链接进来的 skill 目录当独立根再扫一次，条目的根就是那个目录', async () => {
    // 桥的真实语义（原 apps/desktop 的 linked_skill_dir_* 契约测试，已随 T1 删除；今天由
    // packages/host-node 的 listFiles.test.ts 覆盖）：symlink 条目本身出现在列表里、
    // 但不递归进去；把它自己当 root 传回来时，目录内文件是根相对路径。
    const bridge: ProjectSkillsLoaderBridge = {
      async listFiles(path, options) {
        if (options.workspaceRoot === '/home/me' && path === '.claude/skills') {
          return { entries: [{ path: '.claude/skills/linked', type: 'symlink' }] }
        }
        if (options.workspaceRoot === '/home/me/.claude/skills/linked' && path === '.') {
          return {
            entries: [
              { path: 'SKILL.md', type: 'file' },
              { path: 'references/a.md', type: 'file' },
            ],
          }
        }
        throw new Error('path is not accessible: missing')
      },
      async readFile(path, options) {
        if (options.workspaceRoot === '/home/me/.claude/skills/linked' && path === 'SKILL.md') {
          return { content: skill('linked', '被链接的 skill') }
        }
        throw new Error(`ENOENT: ${path}`)
      },
    }

    const snapshot = await scanProjectSkills('/workspace', bridge, { userSkillsRoot: '/home/me' })

    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0]).toMatchObject({
      name: 'user/linked',
      description: '被链接的 skill',
      scope: 'user',
      rootPath: '/home/me/.claude/skills/linked',
      filePath: 'SKILL.md',
      resources: { 'references/a.md': 'references/a.md' },
    })
    expect(snapshot.diagnostics).toEqual([])
  })

  it('链接指向的不是 skill 目录（没有顶层 SKILL.md）→ 静默跳过，不当错误报', async () => {
    const bridge: ProjectSkillsLoaderBridge = {
      async listFiles(path, options) {
        if (options.workspaceRoot === '/workspace' && path === '.claude/skills') {
          return { entries: [{ path: '.claude/skills/notes', type: 'symlink' }] }
        }
        if (options.workspaceRoot === '/workspace/.claude/skills/notes') {
          return { entries: [{ path: 'readme.md', type: 'file' }] }
        }
        throw new Error('path is not accessible: missing')
      },
      async readFile() {
        throw new Error('不该读')
      },
    }

    const snapshot = await scanProjectSkills('/workspace', bridge)

    expect(snapshot.entries).toEqual([])
    expect(snapshot.diagnostics).toEqual([])
  })

  it('经 provider 注入后，CoreInstance 缓存扫描结果并支持强制刷新', async () => {
    const bridge = createBridge(
      [{ path: '.webAgent/skills/deploy/SKILL.md', type: 'file' }],
      { '.webAgent/skills/deploy/SKILL.md': skill('deploy', '部署流程') },
    )
    const provider = vi.fn((workspaceRoot: string) => scanProjectSkills(workspaceRoot, bridge))
    const core = createCoreInstance({ projectSkillsProvider: provider })

    const [first, second] = await Promise.all([
      core.projectSkills.ensure('/workspace'),
      core.projectSkills.ensure('/workspace'),
    ])
    expect(first).toBe(second)
    expect(provider).toHaveBeenCalledTimes(1)
    expect((await core.projectSkills.refresh('/workspace')).entries).toHaveLength(1)
    expect(provider).toHaveBeenCalledTimes(2)
  })
})
