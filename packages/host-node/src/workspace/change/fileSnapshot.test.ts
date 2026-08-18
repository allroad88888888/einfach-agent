import { describe, expect, it } from 'vitest'
import { fileSnapshotFromContent, sameSnapshotState } from './fileSnapshot'

// 期望值全部写成字面量，而不是在测试里「再算一遍」——自证的断言证明不了口径。
/** sha256("hello") */
const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
/** sha256 of the UTF-8 bytes of "中文"（6 字节，不是 UTF-16 的 4 字节） */
const CHINESE_SHA256 = '72726d8818f693066ceb69afa364218b692e62ea92b385782363780f47529c21'
/** sha256("") */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

describe('fileSnapshotFromContent', () => {
  it('有内容：exists 为真，hash 是内容 UTF-8 字节的 sha256 十六进制小写', () => {
    expect(fileSnapshotFromContent('hello')).toEqual({
      exists: true,
      hash: HELLO_SHA256,
      content: 'hello',
    })
  })

  it('内容为 null 表示那一刻文件不存在，hash 也是 null', () => {
    expect(fileSnapshotFromContent(null)).toEqual({ exists: false, hash: null, content: null })
  })

  it('空文件不是「不存在」', () => {
    // 差一个字符的两种状态：回滚时 content 为 null 是**删除**，为空串是**清空**。
    expect(fileSnapshotFromContent('')).toEqual({
      exists: true,
      hash: EMPTY_SHA256,
      content: '',
    })
  })

  it('非 ASCII 内容按 UTF-8 字节哈希（不是 UTF-16 码元）', () => {
    // 中文内容是本仓库的常态；编码口径若与 Rust 的 `value.as_bytes()` 不同，不会报错，只会让两个
    // 宿主对同一份文件算出两个 hash，于是套壳之后回滚永远判定为「文件被改过」。
    expect(fileSnapshotFromContent('中文').hash).toBe(CHINESE_SHA256)
  })
})

describe('sameSnapshotState', () => {
  it('内容相同即同态', () => {
    expect(sameSnapshotState(fileSnapshotFromContent('a'), fileSnapshotFromContent('a'))).toBe(true)
  })

  it('内容不同即非同态', () => {
    expect(sameSnapshotState(fileSnapshotFromContent('a'), fileSnapshotFromContent('b'))).toBe(false)
  })

  it('两边都不存在也算同态', () => {
    expect(sameSnapshotState(fileSnapshotFromContent(null), fileSnapshotFromContent(null))).toBe(
      true,
    )
  })

  it('存在与不存在不同态', () => {
    expect(sameSnapshotState(fileSnapshotFromContent(''), fileSnapshotFromContent(null))).toBe(false)
  })

  it('只比 exists 与 hash，不比 content', () => {
    // 判定与「条目里是否携带正文」解耦：将来若给超大文件改成只记 hash 不记正文，这一侧不用动。
    const withContent = fileSnapshotFromContent('a')
    const hashOnly = { ...withContent, content: null }
    expect(sameSnapshotState(withContent, hashOnly)).toBe(true)
  })
})
