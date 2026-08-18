import { open, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import { startArchiveLockHeartbeat } from './lockArchiveHeartbeat'

let workspace: TempWorkspace
let lockPath: string
let handle: FileHandle
const payload = new TextEncoder().encode('1234-5678')

beforeEach(async () => {
  workspace = await createTempWorkspace()
  lockPath = join(workspace.root, 'index.jsonl.archive-write.lock')
  handle = await open(lockPath, 'w')
})

afterEach(async () => {
  await handle.close().catch(() => {})
  await workspace.cleanup()
})

describe('startArchiveLockHeartbeat', () => {
  it('定时器必须是 unref 的——ref 着的话 CLI 宿主跑完命令不退出', async () => {
    // 这是这个 bug 唯一的可观测面：生产里的症状是「回车之后光标停在那儿」，不指向任何病因。
    const heartbeat = startArchiveLockHeartbeat(handle, payload, 20)
    expect(heartbeat.hasRef()).toBe(false)
    heartbeat.stop()
  })

  it('周期性刷新锁文件的 mtime（陈旧接管看的就是它）', async () => {
    const before = (await stat(lockPath)).mtimeMs
    const heartbeat = startArchiveLockHeartbeat(handle, payload, 20)
    await delay(120)
    heartbeat.stop()
    expect((await stat(lockPath)).mtimeMs).toBeGreaterThan(before)
  })

  it('stop 之后不再刷新', async () => {
    const heartbeat = startArchiveLockHeartbeat(handle, payload, 20)
    await delay(60)
    heartbeat.stop()
    const afterStop = (await stat(lockPath)).mtimeMs
    await delay(80)
    expect((await stat(lockPath)).mtimeMs).toBe(afterStop)
  })

  it('句柄被关掉后心跳自己收摊，不把「锁没了」升级成未捕获异常', async () => {
    const heartbeat = startArchiveLockHeartbeat(handle, payload, 10)
    await handle.close()
    // 这段时间里心跳会写失败若干次；只要有一次异常没接住，vitest 会把整个测试文件判失败。
    await delay(60)
    heartbeat.stop()
    expect(heartbeat.hasRef()).toBe(false)
  })
})
