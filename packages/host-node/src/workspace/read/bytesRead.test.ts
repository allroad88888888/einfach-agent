// 字节分页与 contentHash 的端到端用例，对齐 apps/desktop/src/workspace_read_bytes_tests.rs（已随 T1 删除）。
// 一律经 handler 工厂调用——registrar 挂上去的就是它，绕过工厂直接测内部函数会漏掉「工厂
// 没把 args 透传下去」这类错误。
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReadWorkspaceFileBytesHandler } from './bytesRead'
import { contentSha256 } from './content'
import { MAX_HASH_BYTES, MAX_READ_BYTES } from './limits'
import type { ReadWorkspaceFileResult } from './types'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

function read(args: Record<string, unknown>): Promise<ReadWorkspaceFileResult> {
  return createReadWorkspaceFileBytesHandler({})({
    workspace_root: workspace.root,
    ...args,
  }) as Promise<ReadWorkspaceFileResult>
}

const hashOf = (value: string): string => contentSha256(Buffer.from(value, 'utf8'))

async function seed(relativePath: string, content: string): Promise<void> {
  await writeFile(join(workspace.root, relativePath), content)
}

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('read_workspace_file（字节模式）：一次读完', () => {
  it('返回内容、根相对 path 与整文件哈希', async () => {
    await seed('notes.txt', 'hello read world')

    await expect(read({ path: 'notes.txt' })).resolves.toEqual({
      path: 'notes.txt',
      content: 'hello read world',
      truncated: false,
      bytes: 16,
      offset: 0,
      totalBytes: 16,
      contentHash: hashOf('hello read world'),
    })
  })

  it('读完时不带 nextOffset 键（不是 undefined，是没有这个键）', async () => {
    await seed('notes.txt', 'abc')
    const result = await read({ path: 'notes.txt' })
    expect('nextOffset' in result).toBe(false)
  })

  it('空文件也给哈希，内容为空、不截断', async () => {
    await seed('empty.txt', '')
    await expect(read({ path: 'empty.txt' })).resolves.toMatchObject({
      content: '',
      bytes: 0,
      totalBytes: 0,
      truncated: false,
      contentHash: hashOf(''),
    })
  })
})

describe('read_workspace_file（字节模式）：offset / maxBytes / nextOffset 分页', () => {
  const content = 'ab你cd' // 7 字节：a b [e4 bd a0] c d

  beforeEach(async () => {
    await seed('paged.txt', content)
  })

  it('多字节字符被 maxBytes 切开时无损：本段丢掉残缺尾巴，下段从它开头续上', async () => {
    const first = await read({ path: 'paged.txt', max_bytes: 4, offset: 0 })
    expect(first).toMatchObject({
      content: 'ab',
      offset: 0,
      // maxBytes 是 4，但第 3、4 个字节是「你」的前两个字节，解不出完整字符就不返回。
      bytes: 2,
      nextOffset: 2,
      totalBytes: 7,
      truncated: true,
    })

    const second = await read({ path: 'paged.txt', max_bytes: 4, offset: first.nextOffset })
    expect(second).toMatchObject({ content: '你c', offset: 2, bytes: 4, nextOffset: 6 })

    const third = await read({ path: 'paged.txt', max_bytes: 4, offset: second.nextOffset })
    expect(third).toMatchObject({ content: 'd', offset: 6, truncated: false })
    expect('nextOffset' in third).toBe(false)

    // 三段拼回去与磁盘逐字节相同。
    expect(first.content + second.content + third.content).toBe(content)
  })

  it('offset 正好等于文件长度 → 空段、不截断、无 nextOffset', async () => {
    const result = await read({ path: 'paged.txt', offset: 7 })
    expect(result).toMatchObject({ content: '', bytes: 0, offset: 7, truncated: false })
    expect('nextOffset' in result).toBe(false)
  })

  it('offset 超过文件长度 → 报错，不是空段', async () => {
    await expect(read({ path: 'paged.txt', offset: 8 })).rejects.toThrow(
      /offset 8 exceeds file size 7 for `.*paged\.txt`/,
    )
  })

  it('最后一段即使正好读满 maxBytes 也不算截断（truncated 判的是「还有没有剩」）', async () => {
    const result = await read({ path: 'paged.txt', offset: 5, max_bytes: 2 })
    expect(result).toMatchObject({ content: 'cd', bytes: 2, truncated: false })
    expect('nextOffset' in result).toBe(false)
  })

  it('非法的 offset / max_bytes 当作没传（回落 0 与默认上限），不整体拒绝', async () => {
    await expect(read({ path: 'paged.txt', offset: -1, max_bytes: 0 })).resolves.toMatchObject({
      offset: 0,
      content,
    })
    await expect(
      read({ path: 'paged.txt', offset: 1.5, max_bytes: 'nope' }),
    ).resolves.toMatchObject({ offset: 0, content })
  })
})

describe('read_workspace_file：contentHash 的三条语义', () => {
  it('① 只在 offset 0 的首片返回，续读的分片不带', async () => {
    await seed('paged.txt', '0123456789')

    const opening = await read({ path: 'paged.txt', max_bytes: 4, offset: 0 })
    expect(opening.contentHash).toBe(hashOf('0123456789'))

    const tail = await read({ path: 'paged.txt', max_bytes: 4, offset: 4 })
    expect(tail.offset).toBe(4)
    expect('contentHash' in tail).toBe(false)
  })

  it('② 截断时也返回，且是整文件的哈希而不是本段的', async () => {
    const content = 'line one\nline two\n'.repeat(20_000) // 远超单次读取上限
    await seed('big.txt', content)

    const first = await read({ path: 'big.txt', max_bytes: 100 })
    expect(first.truncated).toBe(true)
    expect(first.bytes).toBe(100)
    // 这条锁的是端到端契约：首段给出的哈希必须正是 write_file 覆盖该文件时校验的那一个。
    expect(first.contentHash).toBe(hashOf(content))
    expect(first.contentHash).not.toBe(hashOf(first.content))
  })

  it('③ 8 MB 以上不返回，内容照常按 maxBytes 给', async () => {
    const oversized = 'y'.repeat(MAX_HASH_BYTES + 1)
    await seed('huge.txt', oversized)

    const result = await read({ path: 'huge.txt', max_bytes: 64 })
    expect(result.totalBytes).toBe(MAX_HASH_BYTES + 1)
    expect(result.truncated).toBe(true)
    expect(result.content.length).toBe(64)
    expect('contentHash' in result).toBe(false)
  })

  it('③ 边界：正好 8 MB 仍然返回', async () => {
    await seed('exact.txt', 'z'.repeat(MAX_HASH_BYTES))
    const result = await read({ path: 'exact.txt', max_bytes: 16 })
    expect(result.totalBytes).toBe(MAX_HASH_BYTES)
    expect(result.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('read_workspace_file：读取上限', () => {
  const content = 'x'.repeat(MAX_READ_BYTES + 10_000)

  it('普通文件钳到 MAX_READ_BYTES，哈希仍是整文件的', async () => {
    await seed('ordinary.txt', content)

    const result = await read({ path: 'ordinary.txt', max_bytes: content.length })
    expect(result.bytes).toBe(MAX_READ_BYTES)
    expect(result.truncated).toBe(true)
    expect(result.contentHash).toBe(hashOf(content))
  })

  it('归档轨迹文件走放宽的上限', async () => {
    await mkdir(join(workspace.root, '.webAgent-archive', 'traces'), { recursive: true })
    await seed('.webAgent-archive/traces/root-01.trace.jsonl', content)

    const result = await read({
      path: '.webAgent-archive/traces/root-01.trace.jsonl',
      max_bytes: content.length,
    })
    expect(result.bytes).toBe(content.length)
    expect(result.truncated).toBe(false)
  })

  it('轨迹目录的判定按路径分量，前缀相同的兄弟目录不放宽', async () => {
    await mkdir(join(workspace.root, '.webAgent-archive', 'tracesX'), { recursive: true })
    await seed('.webAgent-archive/tracesX/root-01.trace.jsonl', content)

    const result = await read({
      path: '.webAgent-archive/tracesX/root-01.trace.jsonl',
      max_bytes: content.length,
    })
    expect(result.bytes).toBe(MAX_READ_BYTES)
  })

  it('不给 max_bytes 时用默认的 20000', async () => {
    await seed('ordinary.txt', content)
    await expect(read({ path: 'ordinary.txt' })).resolves.toMatchObject({ bytes: 20_000 })
  })
})

describe('read_workspace_file：拒读与越界', () => {
  it('path 缺失或全空白 → 与 Rust 同一句话', async () => {
    await expect(read({ path: '   ' })).rejects.toThrow('path (non-empty string) is required')
    await expect(read({})).rejects.toThrow('path (non-empty string) is required')
  })

  it('目录 → not a file', async () => {
    await mkdir(join(workspace.root, 'sub'))
    await expect(read({ path: 'sub' })).rejects.toThrow(/path `.*sub` is not a file/)
  })

  it('含 NUL 字节的文件被判为二进制', async () => {
    await writeFile(join(workspace.root, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62]))
    await expect(read({ path: 'bin.dat' })).rejects.toThrow(/refusing to read binary file/)
  })

  it('非 UTF-8 文件被拒（不是悄悄换成替换字符）', async () => {
    await writeFile(join(workspace.root, 'latin1.txt'), Buffer.from([0x61, 0xff, 0x62]))
    await expect(read({ path: 'latin1.txt' })).rejects.toThrow(/refusing to read non-UTF-8 file/)
  })

  it('越界路径被拒', async () => {
    await writeFile(join(workspace.base, 'secret.txt'), 'top secret')
    await expect(read({ path: '../secret.txt' })).rejects.toThrow(/escapes workspace root/)
  })

  it('allow_external_paths 放行根外读取，path 回绝对路径', async () => {
    await writeFile(join(workspace.base, 'secret.txt'), 'top secret')
    const result = await read({ path: '../secret.txt', allow_external_paths: true })
    expect(result.content).toBe('top secret')
    expect(result.path).toBe(join(workspace.base, 'secret.txt'))
    // 根外文件的相对路径不以 `.webAgent-archive/traces` 开头，上限判定不受影响。
    expect(result.contentHash).toBe(hashOf('top secret'))
  })
})
