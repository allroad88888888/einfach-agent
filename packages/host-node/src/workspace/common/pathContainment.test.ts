import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hasNulByte,
  hasParentSegment,
  isFilesystemRoot,
  isWithinRoot,
  joinRequestedPath,
  normalizeLexically,
} from './pathContainment'

const root = ['', 'srv', 'workspace'].join(sep)

describe('isWithinRoot', () => {
  it('root 自身与其子路径都算在内', () => {
    expect(isWithinRoot(root, root)).toBe(true)
    expect(isWithinRoot(root, `${root}${sep}a${sep}b.txt`)).toBe(true)
  })

  it('前缀陷阱：同前缀的兄弟目录不算 workspace 内', () => {
    // `/srv/workspace-evil` 是磁盘上另一棵树。裸 startsWith 会放行它——Rust 的
    // Path::starts_with 按分量比，从来没这个洞，直译成字符串比较才有。
    expect(isWithinRoot(root, `${root}-evil${sep}secret.txt`)).toBe(false)
    expect(isWithinRoot(root, `${root}x`)).toBe(false)
  })

  it('根外路径与父目录都不算 workspace 内', () => {
    expect(isWithinRoot(root, ['', 'etc', 'passwd'].join(sep))).toBe(false)
    expect(isWithinRoot(root, ['', 'srv'].join(sep))).toBe(false)
  })
})

describe('joinRequestedPath', () => {
  it('相对路径挂到 root 下，绝对路径原样保留', () => {
    expect(joinRequestedPath(root, `a${sep}b.txt`)).toBe(`${root}${sep}a${sep}b.txt`)
    const absolute = ['', 'etc', 'passwd'].join(sep)
    // 绝对路径**不**被挂到 root 下，于是后面的边界判定必然失败——这正是绝对路径逃逸被挡住
    // 的方式，而不是靠某条额外的 if。
    expect(joinRequestedPath(root, absolute)).toBe(absolute)
  })

  it('保留 `..` 不做词法消解', () => {
    // 词法先消 `..` 会与 POSIX realpath 的语义分叉（先解链接、再吃 `..`）。留给 realpath 断案。
    expect(joinRequestedPath(root, `link${sep}..${sep}secret.txt`)).toBe(
      `${root}${sep}link${sep}..${sep}secret.txt`,
    )
  })
})

describe('hasParentSegment', () => {
  it('只认独立的 `..` 分量，不误伤名字里带点的文件', () => {
    expect(hasParentSegment('../secret.txt')).toBe(true)
    expect(hasParentSegment('a/../b')).toBe(true)
    expect(hasParentSegment('..')).toBe(true)
    expect(hasParentSegment('..foo/bar')).toBe(false)
    expect(hasParentSegment('a..b')).toBe(false)
    expect(hasParentSegment('a/b.txt')).toBe(false)
  })
})

describe('normalizeLexically', () => {
  it('消掉 `.`、重复分隔符与结尾分隔符', () => {
    expect(normalizeLexically(`${root}${sep}.${sep}a${sep}${sep}b${sep}`)).toBe(
      `${root}${sep}a${sep}b`,
    )
  })

  it('文件系统根不会被削成空串', () => {
    expect(normalizeLexically(sep)).toBe(sep)
  })
})

describe('hasNulByte / isFilesystemRoot', () => {
  it('NUL 与文件系统根各自可判', () => {
    expect(hasNulByte('a\0b')).toBe(true)
    expect(hasNulByte('a.txt')).toBe(false)
    expect(isFilesystemRoot(sep)).toBe(true)
    expect(isFilesystemRoot(root)).toBe(false)
  })
})
