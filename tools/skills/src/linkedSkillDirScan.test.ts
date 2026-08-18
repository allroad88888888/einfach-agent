import { describe, expect, it } from 'vitest'
import type { ProjectSkillsLoaderBridge } from '@web-agent/core'
import { scanLinkedSkillDir } from './linkedSkillDirScan'

const input = {
  scope: 'user' as const,
  origin: 'claude' as const,
  root: '/home/me',
  relativePath: '.claude/skills/linked',
  label: '~/.claude/skills',
  maxEntries: 2000,
  maxReadBytes: 4096,
}

function bridgeOf(overrides: Partial<ProjectSkillsLoaderBridge>): ProjectSkillsLoaderBridge {
  return {
    async listFiles() {
      return { entries: [{ path: 'SKILL.md', type: 'file' }] }
    },
    async readFile() {
      return { content: '---\nname: linked\ndescription: 被链接的\n---\n正文\n' }
    },
    ...overrides,
  }
}

describe('scanLinkedSkillDir', () => {
  it('把链接目录当独立根：路径全部相对它自己，且不带越界许可', async () => {
    const listRoots: Array<{ root: string; allowExternal: boolean }> = []
    const bridge = bridgeOf({
      async listFiles(_path, options) {
        listRoots.push({ root: options.workspaceRoot, allowExternal: options.allowExternalPaths })
        return {
          entries: [
            { path: 'SKILL.md', type: 'file' },
            { path: 'references/a.md', type: 'file' },
          ],
        }
      },
    })

    const result = await scanLinkedSkillDir(bridge, input)

    expect(result.entry).toMatchObject({
      name: 'user/linked',
      rootPath: '/home/me/.claude/skills/linked',
      filePath: 'SKILL.md',
      resources: { 'references/a.md': 'references/a.md' },
    })
    expect(listRoots).toEqual([
      { root: '/home/me/.claude/skills/linked', allowExternal: false },
    ])
  })

  it('目标里没有顶层 SKILL.md → 静默跳过（链接不一定指向 skill）', async () => {
    const bridge = bridgeOf({
      async listFiles() {
        return { entries: [{ path: 'readme.md', type: 'file' }] }
      },
    })

    await expect(scanLinkedSkillDir(bridge, input)).resolves.toEqual({ diagnostics: [] })
  })

  it('嵌套的 SKILL.md 不算：skill 目录只认它自己的顶层', async () => {
    const bridge = bridgeOf({
      async listFiles() {
        return { entries: [{ path: 'examples/SKILL.md', type: 'file' }] }
      },
    })

    await expect(scanLinkedSkillDir(bridge, input)).resolves.toEqual({ diagnostics: [] })
  })

  it('列不动 / 读不出是真失败，要留诊断而不是静默消失', async () => {
    const listFails = await scanLinkedSkillDir(bridgeOf({
      async listFiles() {
        throw new Error('dangling link')
      },
    }), input)
    expect(listFails.entry).toBeUndefined()
    expect(listFails.diagnostics[0]).toContain('~/.claude/skills/linked: 符号链接目标无法列出')

    const readFails = await scanLinkedSkillDir(bridgeOf({
      async readFile() {
        throw new Error('permission denied')
      },
    }), input)
    expect(readFails.entry).toBeUndefined()
    expect(readFails.diagnostics[0]).toContain('~/.claude/skills/linked: 读取 SKILL.md 失败')
  })
})
