import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changedPaths, stageOperation } from './stage'
import type { PatchOperation, ReadInitialText, StagedFiles } from './types'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

/** W13 的 `read_optional_text_file` 还没落地；暂存只要「有内容还是没有」，这里给个最小实现。 */
const readFromDisk: ReadInitialText = async (path) => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** 记录每个路径被读了几次，用来钉「本批只读一次磁盘」。 */
function countingReader(inner: ReadInitialText = readFromDisk) {
  const calls: string[] = []
  const read: ReadInitialText = async (path) => {
    calls.push(path)
    return inner(path)
  }
  return { calls, read }
}

const stage = (files: StagedFiles, operation: PatchOperation, read: ReadInitialText = readFromDisk) =>
  stageOperation(workspace.root, files, operation, read)

beforeEach(async () => {
  workspace = await createTempWorkspace()
  await writeFile(join(workspace.root, 'existing.txt'), 'on disk')
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('stageOperation', () => {
  it('暂存表按**解析后的绝对路径**做键，磁盘一个字都不动', async () => {
    const files: StagedFiles = new Map()
    await stage(files, { type: 'add_file', path: 'fresh.txt', content: 'hi' })

    expect([...files.keys()]).toEqual([join(workspace.root, 'fresh.txt')])
    expect(files.get(join(workspace.root, 'fresh.txt'))).toEqual({
      initial: null,
      current: 'hi',
      executable: null,
    })
    await expect(readFile(join(workspace.root, 'fresh.txt'), 'utf8')).rejects.toThrow()
  })

  it('`a.txt` 与 `./a.txt` 落进同一格（否则后写的会静默盖掉前一次）', async () => {
    const files: StagedFiles = new Map()
    await stage(files, { type: 'add_file', path: 'fresh.txt', content: 'first' })
    await expect(
      stage(files, { type: 'add_file', path: './fresh.txt', content: 'second' }),
    ).rejects.toThrow(/^file already exists$/)
    expect(files.size).toBe(1)
  })

  it('本批第一次碰到才读磁盘，后续操作看的是暂存内容', async () => {
    const files: StagedFiles = new Map()
    const reader = countingReader()
    await stage(files, {
      type: 'overwrite_file',
      path: 'existing.txt',
      content: 'v2',
      oldContent: 'on disk',
    }, reader.read)
    // 第二次覆盖要拿 v2 当 oldContent——「回磁盘再读一次」会看到 on disk，而它早就不是当前值了。
    await stage(files, {
      type: 'overwrite_file',
      path: 'existing.txt',
      content: 'v3',
      oldContent: 'v2',
    }, reader.read)

    expect(reader.calls).toEqual([join(workspace.root, 'existing.txt')])
    expect(files.get(join(workspace.root, 'existing.txt'))).toEqual({
      initial: 'on disk',
      current: 'v3',
      executable: null,
    })
  })

  it('顺序是「先校验入参、再解析路径」：两处都坏时报的是入参', async () => {
    // 合并这两步就会让这条边角当场翻转，且不会有任何测试之外的症状。
    await expect(
      stage(new Map(), { type: 'add_file', path: '../evil.txt', content: 'a\0b' }),
    ).rejects.toThrow(/^content appears to be binary$/)
  })

  it('路径解析失败不会在表里留下半条记录', async () => {
    const files: StagedFiles = new Map()
    await expect(
      stage(files, { type: 'add_file', path: '../evil.txt', content: 'x' }),
    ).rejects.toThrow(/`\.\.` components/)
    expect(files.size).toBe(0)
  })

  it('规则失败时表里留下的是**读进来的初始状态**，不是半改的状态', async () => {
    const files: StagedFiles = new Map()
    // 磁盘上已有 → 先撞上 current 那条守卫（initial 那条要等文件被本批删空后才轮得到）。
    await expect(
      stage(files, { type: 'add_file', path: 'existing.txt', content: 'x' }),
    ).rejects.toThrow(/^file already exists$/)
    expect(files.get(join(workspace.root, 'existing.txt'))).toEqual({
      initial: 'on disk',
      current: 'on disk',
      executable: null,
    })
  })

  it('磁盘上已有的文件：delete + add 同路径仍被拒（对齐 Rust 的同名用例）', async () => {
    // 放行就等于绕过 overwrite_file 对已存在文件要求 oldContent 的守卫，整文件静默替换。
    const files: StagedFiles = new Map()
    await stage(files, { type: 'delete_file', path: 'existing.txt' })
    await expect(
      stage(files, { type: 'add_file', path: 'existing.txt', content: 'replaced' }),
    ).rejects.toThrow(/use overwrite_file/)
  })

  it('本批内新建的路径：add → delete → add 放行（initial 始终为 null）', async () => {
    const files: StagedFiles = new Map()
    await stage(files, { type: 'add_file', path: 'fresh.txt', content: 'first' })
    await stage(files, { type: 'delete_file', path: 'fresh.txt' })
    await stage(files, { type: 'add_file', path: 'fresh.txt', content: 'second' })

    expect(files.get(join(workspace.root, 'fresh.txt'))?.current).toBe('second')
  })

  it('软链目录：不存在的目标按词法路径入表（穿过软链），已存在的按 canonical', async () => {
    await mkdir(join(workspace.root, 'real'))
    await writeFile(join(workspace.root, 'real', 'kept.txt'), 'kept')
    await symlink(join(workspace.root, 'real'), join(workspace.root, 'link'))
    const files: StagedFiles = new Map()

    await stage(files, { type: 'add_file', path: 'link/fresh.txt', content: 'x' })
    await stage(files, {
      type: 'overwrite_file',
      path: 'link/kept.txt',
      content: 'y',
      oldContent: 'kept',
    })

    expect([...files.keys()].sort()).toEqual([
      join(workspace.root, 'link', 'fresh.txt'),
      join(workspace.root, 'real', 'kept.txt'),
    ])
  })
})

describe('changedPaths', () => {
  it('只挑 initial !== current 的路径；净变化为零的不算', async () => {
    const files: StagedFiles = new Map()
    await stage(files, { type: 'add_file', path: 'fresh.txt', content: 'hi' })
    // 覆盖成与磁盘上完全相同的内容：没有净变化，不该被写、也不该进变更日志。
    await stage(files, {
      type: 'overwrite_file',
      path: 'existing.txt',
      content: 'on disk',
      oldContent: 'on disk',
    })

    expect(changedPaths(workspace.root, files)).toEqual([join(workspace.root, 'fresh.txt')])
  })

  it('本批内 新建 → 删掉：initial 与 current 同为 null，不算变化', async () => {
    const files: StagedFiles = new Map()
    await stage(files, { type: 'add_file', path: 'fresh.txt', content: 'hi' })
    await stage(files, { type: 'delete_file', path: 'fresh.txt' })

    expect(changedPaths(workspace.root, files)).toEqual([])
  })

  it('删除已存在的文件算变化（current 为 null）', async () => {
    const files: StagedFiles = new Map()
    await stage(files, { type: 'delete_file', path: 'existing.txt' })

    expect(changedPaths(workspace.root, files)).toEqual([join(workspace.root, 'existing.txt')])
  })

  it('按展示路径排序，与暂存顺序无关', async () => {
    const files: StagedFiles = new Map()
    await mkdir(join(workspace.root, 'dir'))
    await stage(files, { type: 'add_file', path: 'z.txt', content: '1' })
    await stage(files, { type: 'add_file', path: 'dir/a.txt', content: '2' })
    await stage(files, { type: 'add_file', path: 'b.txt', content: '3' })

    expect(changedPaths(workspace.root, files).map((path) => path.slice(workspace.root.length + 1)))
      .toEqual(['b.txt', 'dir/a.txt', 'z.txt'])
  })

  it('排序按 UTF-8 字节序，不是 JS 默认的 UTF-16 码元序', async () => {
    // 增补平面字符的代理对首码元 0xD800 比 0xFFFD 小，而它的 UTF-8 首字节 0xF0 比 0xEF 大——
    // 直接 sort() 会把这两个文件排反，而这个顺序是模型看到的 changedFiles 顺序。
    const files: StagedFiles = new Map()
    await stage(files, { type: 'add_file', path: '\u{1F600}.txt', content: '1' })
    await stage(files, { type: 'add_file', path: '�.txt', content: '2' })

    const names = changedPaths(workspace.root, files).map((path) =>
      path.slice(workspace.root.length + 1),
    )
    expect(names).toEqual(['�.txt', '\u{1F600}.txt'])
    expect([...names].sort()).not.toEqual(names)
  })
})
