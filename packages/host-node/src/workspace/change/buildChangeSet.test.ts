import { describe, expect, it } from 'vitest'
import { buildChangeSet } from './buildChangeSet'
import type { WorkspaceChangeContext } from './types'

const context: WorkspaceChangeContext = {
  changeId: 'chg-1',
  sessionId: 'sess-1',
  runId: 'run-1',
  toolCallId: 'call-1',
}

const base = { context, workspaceRoot: '/ws', createdAt: 1_700_000_000_000_000_000 }

describe('buildChangeSet', () => {
  it('一次写文件记下改前与改后两份快照', () => {
    const entry = buildChangeSet({
      ...base,
      files: [{ path: 'src/a.ts', before: 'old', after: 'new' }],
    })

    expect(entry.status).toBe('prepared')
    expect(entry.files).toEqual([
      {
        path: 'src/a.ts',
        before: {
          exists: true,
          // sha256("old")
          hash: 'cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4',
          content: 'old',
        },
        after: {
          exists: true,
          // sha256("new")
          hash: '11507a0e2f5e69d5dfa40a62a1bd7b6ee57e6bcd85c67c9b8431b36fff21c437',
          content: 'new',
        },
      },
    ])
  })

  it('新建文件的 before 是「不存在」，不是空内容', () => {
    const entry = buildChangeSet({
      ...base,
      files: [{ path: 'new.txt', before: null, after: 'x' }],
    })
    expect(entry.files[0]?.before).toEqual({ exists: false, hash: null, content: null })
  })

  it('context 的四个字段按 Rust 的展开方式落到顶层', () => {
    const entry = buildChangeSet({ ...base, movedPaths: [{ path: 'gone.txt' }] })
    expect(entry).toMatchObject({
      id: 'chg-1',
      sessionId: 'sess-1',
      runId: 'run-1',
      toolCallId: 'call-1',
      workspaceRoot: '/ws',
      createdAt: 1_700_000_000_000_000_000,
    })
  })

  it('用不到的三个账目数组写成空数组，而不是省略', () => {
    // 写入端始终把四个都写出来，两个宿主的条目形状才完全一致。Rust 读取端的 `#[serde(default)]`
    // 是容错，不是「可以不写」的许可。
    const entry = buildChangeSet({ ...base, movedPaths: [{ path: 'gone.txt' }] })
    const encoded = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>
    expect(Object.keys(encoded)).toContain('files')
    expect(encoded.files).toEqual([])
    expect(encoded.createdPaths).toEqual([])
    expect(encoded.relocatedPaths).toEqual([])
  })

  it('序列化后的键顺序与 Rust 的字段声明顺序一致', () => {
    // serde 按声明顺序输出、JSON.stringify 按插入顺序输出。对齐了两个宿主写出的条目才逐字节相同，
    // W16 的对拍才能直接比字节而不是先规范化。
    const entry = buildChangeSet({ ...base, files: [{ path: 'a', before: null, after: 'x' }] })
    expect(Object.keys(entry)).toEqual([
      'id',
      'sessionId',
      'runId',
      'toolCallId',
      'workspaceRoot',
      'createdAt',
      'status',
      'files',
      'movedPaths',
      'createdPaths',
      'relocatedPaths',
    ])
    expect(Object.keys(entry.files[0] ?? {})).toEqual(['path', 'before', 'after'])
    expect(Object.keys(entry.files[0]?.after ?? {})).toEqual(['exists', 'hash', 'content'])
  })

  it('null 的 content/hash 以显式 null 落到 JSON，不是被丢掉的键', () => {
    // `T?` 会让 JSON.stringify 直接丢键，于是 Node 写的条目比 Tauri 写的少几个键——不报错，
    // 到套壳共用同一份日志时才兑现。
    const encoded = JSON.stringify(
      buildChangeSet({ ...base, files: [{ path: 'a', before: null, after: 'x' }] }),
    )
    expect(encoded).toContain('"before":{"exists":false,"hash":null,"content":null}')
  })

  it('复制与移动各自只填自己那一个数组', () => {
    const copied = buildChangeSet({ ...base, createdPaths: [{ path: 'b', fingerprint: 'f1' }] })
    expect(copied.createdPaths).toEqual([{ path: 'b', fingerprint: 'f1' }])
    expect(copied.relocatedPaths).toEqual([])

    const moved = buildChangeSet({
      ...base,
      relocatedPaths: [{ source: 'a', destination: 'b', fingerprint: 'f2' }],
    })
    expect(moved.relocatedPaths).toEqual([{ source: 'a', destination: 'b', fingerprint: 'f2' }])
    expect(moved.createdPaths).toEqual([])
  })
})
