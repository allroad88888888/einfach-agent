import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildNodeProjectSkillsBridge, resolveWorkspacePath } from './workspace-files'

describe('resolveWorkspacePath', () => {
  it('允许工作区内相对路径', () => {
    expect(resolveWorkspacePath('/tmp/workspace', 'skills/a/SKILL.md')).toBe('/tmp/workspace/skills/a/SKILL.md')
  })

  it('拒绝解析后逃出工作区的路径', () => {
    expect(() => resolveWorkspacePath('/tmp/workspace', '../secret.txt')).toThrow('路径超出工作区边界')
    expect(() => resolveWorkspacePath('/tmp/workspace', '/tmp/secret.txt')).toThrow('路径超出工作区边界')
  })
})

describe('buildNodeProjectSkillsBridge · 符号链接', () => {
  let base = ''

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'cli-skills-'))
    await mkdir(join(base, 'home', '.claude', 'skills'), { recursive: true })
    await mkdir(join(base, 'elsewhere', 'linked'), { recursive: true })
    await writeFile(join(base, 'elsewhere', 'linked', 'SKILL.md'), '---\nname: linked\n---\n')
    await symlink(join(base, 'elsewhere', 'linked'), join(base, 'home', '.claude', 'skills', 'linked'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('列出符号链接条目但不跟进（与桌面端 Rust 侧语义一致）', async () => {
    const bridge = buildNodeProjectSkillsBridge()
    const listed = await bridge.listFiles('.claude/skills', {
      recursive: true,
      includeHidden: true,
      maxEntries: 100,
      workspaceRoot: join(base, 'home'),
      allowExternalPaths: false,
    })

    expect(listed.entries).toEqual([{ path: '.claude/skills/linked', type: 'symlink' }])
  })

  it('把符号链接本身当根时可列可读——loader 正是这样加载被链接进来的 skill', async () => {
    const bridge = buildNodeProjectSkillsBridge()
    const linkRoot = join(base, 'home', '.claude', 'skills', 'linked')

    const listed = await bridge.listFiles('.', {
      recursive: true,
      includeHidden: true,
      maxEntries: 100,
      workspaceRoot: linkRoot,
      allowExternalPaths: false,
    })
    expect(listed.entries).toEqual([{ path: 'SKILL.md', type: 'file' }])

    const read = await bridge.readFile('SKILL.md', {
      maxBytes: 4096,
      workspaceRoot: linkRoot,
      allowExternalPaths: false,
    })
    expect(read.content).toBe('---\nname: linked\n---\n')
  })
})
