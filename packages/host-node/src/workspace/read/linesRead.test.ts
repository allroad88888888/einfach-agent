// 行定位读取的端到端用例，对齐 apps/desktop/src/workspace_read_lines_tests.rs（已随 T1 删除），并补上 Rust 侧
// 没有显式钉住、但两个宿主必须同款的边角：行的定义（末行无换行 / 空文件 / `\r\n` / 裸 `\r`）、
// `offset` 与 `nextOffset` 在行模式下的取值、整文件二进制判定。
// 一律经 `createReadWorkspaceFileHandler`（registrar 要挂的那个工厂）调用，绕过它会漏掉
// 「分派没把行参数透传下去」这类错误；原始入参的收窄用例在 linesDispatch.test.ts。
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contentSha256 } from '../common/contentHash'
import { MAX_HASH_BYTES, MAX_READ_BYTES } from './limits'
import { createReadWorkspaceFileHandler } from './linesDispatch'
import type { ReadWorkspaceFileResult } from './types'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

function read(args: Record<string, unknown>): Promise<ReadWorkspaceFileResult> {
  return createReadWorkspaceFileHandler({})({
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

describe('read_workspace_file（行模式）：定位一段行', () => {
  it('startLine/lineCount 直接给出那几行，并报出四个行字段', async () => {
    // rg_search 报「第 3 行」时，这一步应当是一次直接调用，而不是整段读回来数行。
    await seed('code.rs', 'one\ntwo\nthree\nfour\nfive\n')

    await expect(read({ path: 'code.rs', start_line: 3, line_count: 2 })).resolves.toEqual({
      path: 'code.rs',
      content: 'three\nfour\n',
      truncated: true, // 后面还有第 5 行
      bytes: 11,
      offset: 8, // 'one\ntwo\n'
      totalBytes: 24,
      nextOffset: 19,
      startLine: 3,
      endLine: 4,
      nextLine: 5,
      totalLines: 5,
    })
  })

  it('lineCount 不给 = 读到文件末尾，读完时不带 nextLine / nextOffset 键', async () => {
    await seed('code.rs', 'a\nb\nc\n')

    const result = await read({ path: 'code.rs', start_line: 2 })
    expect(result).toMatchObject({ content: 'b\nc\n', endLine: 3, truncated: false })
    expect('nextLine' in result).toBe(false)
    expect('nextOffset' in result).toBe(false)
  })

  it('顺着 nextLine 走一遍，拼回去与磁盘逐字节一致', async () => {
    const content = 'a\nb\nc\nd\n'
    await seed('code.rs', content)

    let cursor: number | undefined = 1
    let seen = ''
    while (cursor !== undefined) {
      const chunk: ReadWorkspaceFileResult = await read({
        path: 'code.rs',
        start_line: cursor,
        line_count: 3,
      })
      seen += chunk.content
      cursor = chunk.nextLine
    }

    expect(seen).toBe(content)
  })
})

describe('read_workspace_file（行模式）：行是怎么切的', () => {
  it('CRLF 原样保留，`\\r\\n` 不额外成行', async () => {
    // 把行尾规范化成 LF 会让读到的内容无法当作 apply_patch 的 oldText 使用。
    await seed('win.txt', 'alpha\r\nbeta\r\ngamma\r\n')

    await expect(read({ path: 'win.txt', start_line: 2, line_count: 1 })).resolves.toMatchObject({
      content: 'beta\r\n',
      bytes: 6,
      offset: 7,
      totalLines: 3,
    })
  })

  it('裸 `\\r` 不是行分隔符', async () => {
    await seed('cr.txt', 'a\rb\nc\n')
    await expect(read({ path: 'cr.txt', start_line: 1 })).resolves.toMatchObject({
      totalLines: 2,
      content: 'a\rb\nc\n',
    })
  })

  it('末行没有换行符仍然算一行', async () => {
    await seed('tail.txt', 'a\nb')

    const result = await read({ path: 'tail.txt', start_line: 2 })
    expect(result).toMatchObject({
      content: 'b',
      startLine: 2,
      endLine: 2,
      totalLines: 2,
      truncated: false,
      offset: 2,
      bytes: 1,
    })
  })

  it('只有一个换行符的文件是 1 行', async () => {
    await seed('nl.txt', '\n')
    await expect(read({ path: 'nl.txt', start_line: 1 })).resolves.toMatchObject({
      content: '\n',
      totalLines: 1,
      endLine: 1,
    })
  })

  it('空文件是 0 行（不是 1 行），于是第 1 行就已越界', async () => {
    await seed('empty.txt', '')
    await expect(read({ path: 'empty.txt', start_line: 1 })).rejects.toThrow(
      /startLine 1 exceeds the file's 0 line\(s\) in `.*empty\.txt`/,
    )
  })

  it('多字节字符按 UTF-8 字节计入 bytes / offset', async () => {
    await seed('cn.txt', '你好\n世界\n')

    const result = await read({ path: 'cn.txt', start_line: 2 })
    expect(result).toMatchObject({
      content: '世界\n',
      offset: 7,
      bytes: 7,
      totalBytes: 14,
      truncated: false,
    })
  })
})

describe('read_workspace_file（行模式）：maxBytes 按整行截断', () => {
  it('加上下一行就会超上限 → 停在整行边界', async () => {
    // 半行内容既不能用作 oldText，也无法让模型判断自己看到了什么。
    await seed('code.rs', 'aaaa\nbbbb\ncccc\n')

    await expect(
      read({ path: 'code.rs', start_line: 1, line_count: 3, max_bytes: 7 }),
    ).resolves.toMatchObject({
      content: 'aaaa\n',
      endLine: 1,
      nextLine: 2,
      nextOffset: 5,
      truncated: true,
    })
  })

  it('单独一行就超上限时仍整行返回（否则续读原地打转）', async () => {
    await seed('long.txt', 'aaaaaaaaaa\nb\n')

    await expect(read({ path: 'long.txt', start_line: 1, max_bytes: 4 })).resolves.toMatchObject({
      content: 'aaaaaaaaaa\n',
      bytes: 11,
      endLine: 1,
      nextLine: 2,
    })
  })

  it('max_bytes 钳到 MAX_READ_BYTES，且行模式不吃字节模式的轨迹目录放宽', async () => {
    await mkdir(join(workspace.root, '.webAgent-archive', 'traces'), { recursive: true })
    const line = `${'x'.repeat(999)}\n` // 1000 字节一行
    const content = line.repeat(300) // 300_000 字节，超过 MAX_READ_BYTES
    await seed('.webAgent-archive/traces/root-01.trace.jsonl', content)

    const result = await read({
      path: '.webAgent-archive/traces/root-01.trace.jsonl',
      start_line: 1,
      max_bytes: content.length,
    })
    expect(result.bytes).toBe(MAX_READ_BYTES)
    expect(result.endLine).toBe(MAX_READ_BYTES / 1000)
    expect(result.truncated).toBe(true)
  })
})

describe('read_workspace_file（行模式）：contentHash', () => {
  it('startLine 1 给整文件哈希，其它起始行不给（键不存在）', async () => {
    const content = 'one\ntwo\nthree\n'
    await seed('code.rs', content)

    const first = await read({ path: 'code.rs', start_line: 1, line_count: 1 })
    expect(first.contentHash).toBe(hashOf(content))

    const later = await read({ path: 'code.rs', start_line: 2, line_count: 1 })
    expect('contentHash' in later).toBe(false)
  })

  it('startLine 1 被 maxBytes 截断时仍给，且是整文件的哈希', async () => {
    const content = 'aaaa\nbbbb\ncccc\n'
    await seed('code.rs', content)

    const result = await read({ path: 'code.rs', start_line: 1, max_bytes: 6 })
    expect(result.truncated).toBe(true)
    expect(result.contentHash).toBe(hashOf(content))
    expect(result.contentHash).not.toBe(hashOf(result.content))
  })
})

describe('read_workspace_file（行模式）：拒读', () => {
  it('startLine 0 / lineCount 0 / 越过末行各有自己的说法', async () => {
    await seed('code.rs', 'a\nb\n')

    await expect(read({ path: 'code.rs', start_line: 0 })).rejects.toThrow(
      'startLine is 1-based; use 1 for the first line',
    )
    await expect(read({ path: 'code.rs', start_line: 1, line_count: 0 })).rejects.toThrow(
      'lineCount must be greater than 0',
    )
    await expect(read({ path: 'code.rs', start_line: 9 })).rejects.toThrow(
      /startLine 9 exceeds the file's 2 line\(s\)/,
    )
  })

  it('入参自相矛盾时先于文件系统判定（路径不存在也报行号的错）', async () => {
    await expect(read({ path: 'nope.txt', start_line: 0 })).rejects.toThrow('startLine is 1-based')
  })

  it('path 缺失或全空白 → 与 Rust 同一句话', async () => {
    const message = 'path (non-empty string) is required'
    await expect(read({ path: '   ', start_line: 1 })).rejects.toThrow(message)
    await expect(read({ start_line: 1 })).rejects.toThrow(message)
  })

  it('目录 → not a file', async () => {
    await mkdir(join(workspace.root, 'sub'))
    await expect(read({ path: 'sub', start_line: 1 })).rejects.toThrow(/path `.*sub` is not a file/)
  })

  it('二进制判定看整个文件，不只是要返回的那几行', async () => {
    // 字节模式只判要返回的那一段；行模式整文件读入，NUL 在第 3 行也会让读第 1 行整体失败。
    await writeFile(join(workspace.root, 'bin.dat'), Buffer.from('ok\nfine\n\0\n', 'binary'))
    await expect(read({ path: 'bin.dat', start_line: 1, line_count: 1 })).rejects.toThrow(
      /refusing to read binary file/,
    )
  })

  it('非 UTF-8 文件被拒（不是悄悄换成替换字符）', async () => {
    await writeFile(join(workspace.root, 'latin1.txt'), Buffer.from([0x61, 0xff, 0x0a]))
    await expect(read({ path: 'latin1.txt', start_line: 1 })).rejects.toThrow(
      /refusing to read non-UTF-8 file/,
    )
  })

  it('越界路径被拒；allow_external_paths 放行后 path 回绝对路径', async () => {
    await writeFile(join(workspace.base, 'secret.txt'), 'top\nsecret\n')

    await expect(read({ path: '../secret.txt', start_line: 1 })).rejects.toThrow(
      /escapes workspace root/,
    )

    const result = await read({
      path: '../secret.txt',
      start_line: 2,
      allow_external_paths: true,
    })
    expect(result.content).toBe('secret\n')
    expect(result.path).toBe(join(workspace.base, 'secret.txt'))
  })

  it('超过 8 MB 的文件整体拒绝行寻址，并指路字节分页', async () => {
    // 定位第 N 行必须先看过它前面所有字节，所以行模式按整文件读入；上限就是 contentHash 的上限。
    await seed('huge.txt', 'y'.repeat(MAX_HASH_BYTES + 1))

    await expect(read({ path: 'huge.txt', start_line: 1 })).rejects.toThrow(
      new RegExp(
        `file \`.*huge\\.txt\` is ${MAX_HASH_BYTES + 1} bytes, too large for line addressing; ` +
          'read it in byte chunks with offset/nextOffset instead',
      ),
    )
  })

  it('正好 8 MB 仍可行寻址', async () => {
    await seed('exact.txt', `${'z'.repeat(MAX_HASH_BYTES - 1)}\n`)
    await expect(read({ path: 'exact.txt', start_line: 1, max_bytes: 16 })).resolves.toMatchObject({
      totalBytes: MAX_HASH_BYTES,
      totalLines: 1,
    })
  })
})
