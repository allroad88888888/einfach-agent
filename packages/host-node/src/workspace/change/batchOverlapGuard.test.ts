import { describe, expect, it } from 'vitest'
import { batchOverlapMessage } from './batchOverlapGuard'
import { buildChangeSet } from './buildChangeSet'
import type { ChangeSetDraft } from './buildChangeSet'
import type { WorkspaceChangeSet } from './types'

const OVERLAP =
  'batch rollback cannot safely combine overlapping path-delete and file changes'

// 纯判定，不碰盘——所以这里直接拿 buildChangeSet 造账，不建临时目录树。
function entry(id: string, draft: Omit<ChangeSetDraft, 'context' | 'workspaceRoot' | 'createdAt'>): WorkspaceChangeSet {
  return buildChangeSet({
    context: { changeId: id, sessionId: 's', runId: 'r', toolCallId: 'c' },
    workspaceRoot: '/ws',
    createdAt: 1,
    ...draft,
  })
}

describe('batchOverlapMessage', () => {
  it('同一个文件被连续改过两次是正常用法，不算重叠', () => {
    const pending = [
      entry('one', { files: [{ path: 'a.txt', before: 'v1', after: 'v2' }] }),
      entry('two', { files: [{ path: 'a.txt', before: 'v2', after: 'v3' }] }),
    ]
    expect(batchOverlapMessage(pending)).toBeNull()
  })

  it('同一路径既被整文件改写又被删除 → 拒', () => {
    const pending = [
      entry('one', { files: [{ path: 'a.txt', before: 'v1', after: 'v2' }] }),
      entry('two', { movedPaths: [{ path: 'a.txt' }] }),
    ]
    expect(batchOverlapMessage(pending)).toBe(OVERLAP)
  })

  it('同一路径既被整文件改写又被复制出来 → 拒', () => {
    const pending = [
      entry('one', { files: [{ path: 'copy.txt', before: null, after: 'x' }] }),
      entry('two', { createdPaths: [{ path: 'copy.txt', fingerprint: 'fp' }] }),
    ]
    expect(batchOverlapMessage(pending)).toBe(OVERLAP)
  })

  it('同一路径在两条账里都被删除 → 拒（后退的那条会盖掉先退的）', () => {
    const pending = [
      entry('one', { movedPaths: [{ path: 'gone' }] }),
      entry('two', { movedPaths: [{ path: 'gone' }] }),
    ]
    expect(batchOverlapMessage(pending)).toBe(OVERLAP)
  })

  it('一次移动的 source 又是另一次移动的 destination → 拒', () => {
    const pending = [
      entry('one', { relocatedPaths: [{ source: 'a', destination: 'b', fingerprint: 'fp' }] }),
      entry('two', { relocatedPaths: [{ source: 'b', destination: 'c', fingerprint: 'fp' }] }),
    ]
    expect(batchOverlapMessage(pending)).toBe(OVERLAP)
  })

  it('互不相干的四类账放在一起没问题', () => {
    const pending = [
      entry('one', { files: [{ path: 'a.txt', before: 'v1', after: 'v2' }] }),
      entry('two', { movedPaths: [{ path: 'gone' }] }),
      entry('three', { createdPaths: [{ path: 'copy', fingerprint: 'fp' }] }),
      entry('four', { relocatedPaths: [{ source: 'x', destination: 'y', fingerprint: 'fp' }] }),
    ]
    expect(batchOverlapMessage(pending)).toBeNull()
  })

  it('空批次没有重叠', () => {
    expect(batchOverlapMessage([])).toBeNull()
  })
})
