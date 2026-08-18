import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import { acquireArchivePathLock } from './lockArchive'
import { archiveLockPath } from './lockArchiveRules'

let workspace: TempWorkspace
let target: string

/** 测试用的时长：真等 10 秒超时 / 30 秒陈旧的话这个文件要跑一分钟。 */
const FAST = { waitMs: 300, staleMs: 30_000, heartbeatMs: 60 }

beforeEach(async () => {
  workspace = await createTempWorkspace()
  target = join(workspace.root, 'index.jsonl')
  await writeFile(target, '')
})

afterEach(async () => {
  await workspace.cleanup()
})

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  )
}

describe('acquireArchivePathLock —— 抢占与释放', () => {
  it('抢到锁时留下一个写着持有者 token 的锁文件', async () => {
    const lock = await acquireArchivePathLock(target, FAST)
    expect(lock.lockPath).toBe(archiveLockPath(target))
    await expect(readFile(lock.lockPath, 'utf8')).resolves.toMatch(
      new RegExp(`^${process.pid}-\\d+$`),
    )
    await lock.release()
  })

  it('释放后锁文件消失，下一个人立刻拿得到', async () => {
    const first = await acquireArchivePathLock(target, FAST)
    await first.release()
    expect(await exists(first.lockPath)).toBe(false)
    const second = await acquireArchivePathLock(target, FAST)
    await second.release()
  })

  it('已被持有时抢占失败，等到预算用尽才报超时（消息里带锁文件路径）', async () => {
    const held = await acquireArchivePathLock(target, FAST)
    const startedAt = Date.now()
    await expect(acquireArchivePathLock(target, { ...FAST, waitMs: 80 })).rejects.toThrow(
      `timed out waiting for archive path lock \`${held.lockPath}\``,
    )
    // 真的等过：秒失败说明轮询根本没跑，那样跨进程等待形同虚设。
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60)
    await held.release()
  })

  it('等锁的那个在持有者释放之后拿到锁（对齐 Rust archive_path_lock_serializes_owners）', async () => {
    const first = await acquireArchivePathLock(target, FAST)
    let acquiredSecond = false
    const second = acquireArchivePathLock(target, { ...FAST, waitMs: 2_000 }).then((lock) => {
      acquiredSecond = true
      return lock
    })

    await delay(80)
    expect(acquiredSecond).toBe(false)

    await first.release()
    const lock = await second
    expect(acquiredSecond).toBe(true)
    await lock.release()
    expect(await exists(archiveLockPath(target))).toBe(false)
  })

  it('两次 release 不抛错（释放在 finally 里，重复调用不能变成新的失败）', async () => {
    const lock = await acquireArchivePathLock(target, FAST)
    await lock.release()
    await expect(lock.release()).resolves.toBeUndefined()
  })

  it('父目录不存在时给出 `failed to acquire archive path lock`', async () => {
    await expect(
      acquireArchivePathLock(join(workspace.root, 'missing', 'index.jsonl'), FAST),
    ).rejects.toThrow(/^failed to acquire archive path lock: /)
  })
})

describe('acquireArchivePathLock —— 陈旧接管', () => {
  it('心跳超时的锁会被接管，且接管者的锁不会被原持有者的释放删掉', async () => {
    // 直译 Rust 的 stale_archive_lock_recovery_does_not_remove_replacement：
    // 原持有者释放时锁文件里已经是接管者的 token，必须**留着**。
    const first = await acquireArchivePathLock(target, FAST)
    const replacement = await acquireArchivePathLock(target, { ...FAST, staleMs: 0 })
    expect(replacement.lockPath).toBe(first.lockPath)

    await first.release()
    expect(await exists(first.lockPath)).toBe(true)
    await expect(readFile(first.lockPath, 'utf8')).resolves.not.toBe('')

    await replacement.release()
    expect(await exists(first.lockPath)).toBe(false)
  })

  it('接管留下的 `.stale-<token>` 中间文件被清掉，不在工作区里堆垃圾', async () => {
    const first = await acquireArchivePathLock(target, FAST)
    const replacement = await acquireArchivePathLock(target, { ...FAST, staleMs: 0 })
    const { readdir } = await import('node:fs/promises')
    const leftovers = (await readdir(workspace.root)).filter((name) => name.includes('.stale-'))
    expect(leftovers).toEqual([])
    await replacement.release()
    await first.release()
  })

  it('没超时的锁不会被接管——接管判据是心跳年龄，不是「有人在等」', async () => {
    const held = await acquireArchivePathLock(target, FAST)
    await expect(
      acquireArchivePathLock(target, { ...FAST, waitMs: 60, staleMs: 30_000 }),
    ).rejects.toThrow(/timed out waiting for archive path lock/)
    await held.release()
  })

  it('心跳持续刷新锁文件，持有者因此不会被自己的等待者判成陈旧', async () => {
    // 心跳是「持有者还活着」的唯一证据。它停了（比如漏了 setInterval），一把默认 30 秒陈旧的锁
    // 在长写入里会被别人接管，两个进程同时写同一个归档。
    const lock = await acquireArchivePathLock(target, { ...FAST, heartbeatMs: 20 })
    const before = (await stat(lock.lockPath)).mtimeMs
    await delay(150)
    const after = (await stat(lock.lockPath)).mtimeMs
    expect(after).toBeGreaterThan(before)
    // 刷新写的是同样的字节，内容不能被写花。
    await expect(readFile(lock.lockPath, 'utf8')).resolves.toMatch(
      new RegExp(`^${process.pid}-\\d+$`),
    )
    await lock.release()
  })
})
