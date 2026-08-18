import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { relativeToRoot, toSlashPath } from './displayPath'

const root = ['', 'srv', 'workspace'].join(sep)

describe('relativeToRoot', () => {
  it('根内路径转成根相对的斜杠路径', () => {
    expect(relativeToRoot(root, `${root}${sep}src${sep}a.txt`)).toBe('src/a.txt')
  })

  it('root 自身显示为 `.`', () => {
    expect(relativeToRoot(root, root)).toBe('.')
  })

  it('根外路径原样给出绝对路径', () => {
    // Auto 会话读到根外文件时的正常输出：显示它真正在哪，而不是 `../../etc/passwd` 这种
    // 既不是 Rust 行为、也读不出「这在根外」的相对写法。
    const outside = ['', 'etc', 'passwd'].join(sep)
    expect(relativeToRoot(root, outside)).toBe(toSlashPath(outside))
  })

  it('同前缀的兄弟目录按根外处理，不会被削成半截相对路径', () => {
    const sibling = `${root}-evil${sep}secret.txt`
    expect(relativeToRoot(root, sibling)).toBe(toSlashPath(sibling))
  })
})
