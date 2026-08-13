import { describe, expect, it } from 'vitest'
import { resolveWorkspacePath } from './workspace-files'

describe('resolveWorkspacePath', () => {
  it('允许工作区内相对路径', () => {
    expect(resolveWorkspacePath('/tmp/workspace', 'skills/a/SKILL.md')).toBe('/tmp/workspace/skills/a/SKILL.md')
  })

  it('拒绝解析后逃出工作区的路径', () => {
    expect(() => resolveWorkspacePath('/tmp/workspace', '../secret.txt')).toThrow('路径超出工作区边界')
    expect(() => resolveWorkspacePath('/tmp/workspace', '/tmp/secret.txt')).toThrow('路径超出工作区边界')
  })
})
