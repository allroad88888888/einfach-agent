import { describe, expect, it, vi } from 'vitest'
import {
  createCoreInstance,
  type ProjectSkillsLoaderBridge,
} from '@web-agent/core/runtime/core/coreInstance'
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
    expect(snapshot.diagnostics.join('\n')).toContain('.webAgent 同名')
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
