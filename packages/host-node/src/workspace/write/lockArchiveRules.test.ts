import { describe, expect, it } from 'vitest'
import { archiveLockPath, archiveLockStalePath, isArchiveLockStale } from './lockArchiveRules'

describe('archiveLockPath', () => {
  it('锁文件是目标的同目录兄弟，后缀与 Rust 逐字一致', () => {
    expect(archiveLockPath('/ws/.webAgent-archive/index.jsonl')).toBe(
      '/ws/.webAgent-archive/index.jsonl.archive-write.lock',
    )
  })

  it('没有扩展名的目标一样能算出锁路径', () => {
    expect(archiveLockPath('/ws/notes')).toBe('/ws/notes.archive-write.lock')
  })

  it('没有文件名的路径被拒（对齐 Rust `file_name()` 返回 None 的三种情形）', () => {
    for (const target of ['/', '/ws/..', '/ws/.', '.']) {
      expect(() => archiveLockPath(target)).toThrow('archive path lock requires a file target')
    }
  })
})

describe('archiveLockStalePath', () => {
  it('替换最后一段扩展名而不是追加（Rust 的 with_extension 语义）', () => {
    expect(archiveLockStalePath('/ws/index.jsonl.archive-write.lock', '42-7')).toBe(
      '/ws/index.jsonl.archive-write.stale-42-7',
    )
  })

  it('两个接管者的目的地一定不同名——胜负由 rename 分出，不会互删', () => {
    const lockPath = '/ws/index.jsonl.archive-write.lock'
    expect(archiveLockStalePath(lockPath, 'a')).not.toBe(archiveLockStalePath(lockPath, 'b'))
  })
})

describe('isArchiveLockStale', () => {
  it('年龄够了就算陈旧，差一毫秒都不算', () => {
    expect(isArchiveLockStale(30_000, 30_000)).toBe(true)
    expect(isArchiveLockStale(29_999, 30_000)).toBe(false)
  })

  it('staleMs 为 0 时任何非负年龄都算陈旧（测试构造「立刻可接管」的唯一入口）', () => {
    expect(isArchiveLockStale(0, 0)).toBe(true)
  })

  it('未来的 mtime 一律不算陈旧——时钟回拨不该变成「两个进程同时写」', () => {
    expect(isArchiveLockStale(-1, 0)).toBe(false)
    expect(isArchiveLockStale(-60_000, 30_000)).toBe(false)
  })

  it('读不出年龄（NaN）时保守判定为不陈旧', () => {
    expect(isArchiveLockStale(Number.NaN, 0)).toBe(false)
  })
})
