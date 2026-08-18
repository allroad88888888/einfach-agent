// 跨进程的归档写锁：锁文件 + token + 心跳 + 陈旧接管
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_write_lock.rs 的 `ArchivePathLock`。
//
// 进程内那把锁（lockTable.ts）只管本进程；子 Agent 归档是**多个进程**往同一个 `.jsonl` 上追加
// 的场景（桌面宿主、CLI 宿主、下一次 run），那条队列在别的进程里根本不存在。所以这一层把互斥
// 落到文件系统上——那是几个进程唯一都看得见的东西。
//
// 四件事各自挡什么：
//   · **抢占**：`open(path, 'wx')`（O_CREAT|O_EXCL）。「不存在就建、已存在就失败」由内核一次
//     完成，中间没有让别人插进来的窗口。先 `exists()` 再 `open()` 就有那个窗口，两个进程都会
//     看到「不存在」。
//   · **token**：锁文件里写着持有者的身份。释放时先比对再删——中间发生过接管的话，文件已经
//     属于别人，删掉就是把别人的锁抢走了。没有 token 的话「删掉锁文件」这一步无法判断安全性。
//   · **心跳**（lockArchiveHeartbeat.ts）：持有者活着的证据。持有者可能跑很久，光靠创建时间
//     没法区分「在干活」和「已经死了」。
//   · **陈旧接管**：持有者被 kill -9 时锁文件会永远留着——没有进程再去删它。心跳超时是唯一能
//     把这种锁收回来的机制，代价是「假死」的持有者（比如被 SIGSTOP）会被误判，这个取舍与
//     Rust 一致。
//
// 【失败的形态】
// Rust 侧 `acquire` 返回 `Result<_, String>`，流水线把 Err 折成 `ok: false` 的结果。Node 侧这里
// 一律 `throw new Error(...)`，消息与 Rust 逐字一致；折成结构化结果是 W7 流水线的事，与
// `resolveWriteTarget` 的分工一样。

import { open, readFile, rename, stat, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { errorText } from '../common'
import { ARCHIVE_LOCK_POLL_MS, ARCHIVE_LOCK_STALE_MS, ARCHIVE_LOCK_WAIT_MS } from './limits'
import { archiveLockPath, archiveLockStalePath, isArchiveLockStale } from './lockArchiveRules'
import { ARCHIVE_LOCK_HEARTBEAT_MS, startArchiveLockHeartbeat } from './lockArchiveHeartbeat'
import type { ArchiveLockHeartbeat } from './lockArchiveHeartbeat'

/** 一把已经持有的归档写锁。Rust 靠 Drop 释放，JS 没有 Drop，所以调用方必须在 finally 里调它。 */
export interface ArchivePathLock {
  /** 锁文件的绝对路径。留在公开面上是为了让失败诊断和测试都能指得出具体是哪个文件。 */
  readonly lockPath: string
  /** 停心跳、关句柄、删掉**仍属于自己**的锁文件。可重复调用，永不抛错。 */
  release(): Promise<void>
}

/** 三个时长都可覆盖，理由只有一个：测试等不起 10 秒超时、30 秒陈旧和 5 秒心跳。 */
export interface AcquireArchiveLockOptions {
  waitMs?: number
  staleMs?: number
  heartbeatMs?: number
}

/**
 * 拿到 `targetPath` 的跨进程写锁，拿不到就抛。
 *
 * 轮询而不是 watch：锁文件的释放是另一个**进程**做的，跨进程的唤醒本来就得靠文件系统事件，
 * 而 fs.watch 在各平台的语义差异比 20ms 轮询的开销大得多。Rust 侧同样是 sleep + 重试。
 */
export async function acquireArchivePathLock(
  targetPath: string,
  options: AcquireArchiveLockOptions = {},
): Promise<ArchivePathLock> {
  const waitMs = options.waitMs ?? ARCHIVE_LOCK_WAIT_MS
  const staleMs = options.staleMs ?? ARCHIVE_LOCK_STALE_MS
  const heartbeatMs = options.heartbeatMs ?? ARCHIVE_LOCK_HEARTBEAT_MS
  const lockPath = archiveLockPath(targetPath)
  const startedAt = Date.now()
  const token = createLockToken()

  for (;;) {
    const handle = await tryCreateLockFile(lockPath)
    if (handle !== undefined) return await beginOwnership(lockPath, handle, token, heartbeatMs)
    // 接管成功就立刻重试抢占，不消耗等待预算——对齐 Rust 的 `continue`。
    if (await takeOverStaleLock(lockPath, staleMs, token)) continue
    if (Date.now() - startedAt >= waitMs) {
      throw new Error(`timed out waiting for archive path lock \`${lockPath}\``)
    }
    await delay(ARCHIVE_LOCK_POLL_MS)
  }
}

/**
 * 持有者身份。Rust 用 `{pid}-{纪元纳秒}`；Node 的 `Date.now()` 只有毫秒，同一毫秒内起两把锁
 * 会撞出同一个 token，而 token 撞了就意味着 A 释放时会认领 B 的锁文件。改用
 * `process.hrtime.bigint()`（进程内单调、纳秒）——pid 分进程，hrtime 分进程内的先后，撞不了。
 * 只有相等比较会跨进程发生，token 的**格式**不需要与 Rust 一致。
 */
function createLockToken(): string {
  return `${process.pid}-${process.hrtime.bigint()}`
}

/** 抢占一次。`undefined` = 锁已被别人持有（EEXIST）；其余 IO 失败直接抛。 */
async function tryCreateLockFile(lockPath: string): Promise<FileHandle | undefined> {
  try {
    return await open(lockPath, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw new Error(`failed to acquire archive path lock: ${errorText(error)}`)
  }
}

/**
 * 抢到之后：写 token、起心跳、交出释放函数。
 *
 * 写 token 失败必须把锁文件删掉再抛：留下一个**空**锁文件的话，它没有任何持有者，只能等
 * 陈旧超时（默认 30 秒）才被接管，而这段时间里没有任何人能写这个归档。
 */
async function beginOwnership(
  lockPath: string,
  handle: FileHandle,
  token: string,
  heartbeatMs: number,
): Promise<ArchivePathLock> {
  const payload = new TextEncoder().encode(token)
  try {
    await handle.write(payload, 0, payload.length, 0)
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(lockPath).catch(() => {})
    throw new Error(`failed to initialize archive path lock: ${errorText(error)}`)
  }
  const heartbeat = startArchiveLockHeartbeat(handle, payload, heartbeatMs)
  return {
    lockPath,
    release: () => releaseOwnership(lockPath, handle, token, heartbeat),
  }
}

/**
 * 释放：停心跳 → 关句柄 → **确认锁文件还写着自己的 token** → 删。
 *
 * 中间那道确认是 Rust 的 `if fs::read_to_string(...) == Some(self.token)`，不是保险起见：
 * 自己被误判成陈旧、锁已经被别人接管时，文件里是别人的 token，这时删掉等于让第三方也能进去，
 * 两个持有者同时写。宁可把一把不属于自己的锁留给它真正的主人。
 *
 * 全程吞异常：释放发生在 finally 里，让它抛只会盖住真正的写入错误。
 */
async function releaseOwnership(
  lockPath: string,
  handle: FileHandle,
  token: string,
  heartbeat: ArchiveLockHeartbeat,
): Promise<void> {
  // 顺序不能反：先关句柄的话，正在跑的最后一次心跳会写到已关闭的 fd 上。
  heartbeat.stop()
  await handle.close().catch(() => {})
  const current = await readFile(lockPath, 'utf8').catch(() => undefined)
  if (current === token) await unlink(lockPath).catch(() => {})
}

/**
 * 试着接管一把陈旧锁。返回是否接管成功（成功后调用方立刻重试抢占）。
 *
 * 「改名到带 token 的路径再删」而不是直接删，理由写在 `archiveLockStalePath` 的注释里：
 * 那是两个等待者同时判定陈旧时唯一能分出胜负的一步。改名失败一律当作没接管——多半是别人
 * 抢先了，或者持有者恰好在这一刻自己释放了，两种情况都该回到轮询而不是报错。
 */
async function takeOverStaleLock(
  lockPath: string,
  staleMs: number,
  token: string,
): Promise<boolean> {
  const ageMs = await archiveLockAgeMs(lockPath)
  if (ageMs === undefined || !isArchiveLockStale(ageMs, staleMs)) return false
  const stalePath = archiveLockStalePath(lockPath, token)
  try {
    await rename(lockPath, stalePath)
  } catch {
    return false
  }
  await unlink(stalePath).catch(() => {})
  return true
}

/**
 * 锁文件距上次刷新过了多久；文件读不到（已被释放、权限问题）返回 `undefined`。
 *
 * Rust 那边 metadata 失败会顺着 `.ok()` 变成「不陈旧」，这里的 `undefined` 走到同一个结论。
 * 分成两个值而不是直接返回 bool，是为了把「有没有这个文件」和「够不够旧」分开——后者是
 * lockArchiveRules 里那条能被单独对拍的纯判定。
 *
 * **mtime 先向下取整到毫秒**，因为两个读数的精度不一样：`Date.now()` 只有毫秒，而
 * `stats.mtimeMs` 带小数（APFS/ext4 的时间戳是纳秒精度）。刚刷新过的锁文件 mtime 是 `…123.4`
 * 而此刻 `Date.now()` 是 `…123`，直接相减得到 -0.4，按 `isArchiveLockStale` 的约定那是「未来的
 * mtime、不陈旧」。后果不严重（下一轮轮询就正常了，年龄上限也只多算 1 毫秒），但那是纯粹的
 * 精度错配造成的抖动，不是任何真实的时间关系。Rust 侧两边都是纳秒精度，没有这个错配。
 */
async function archiveLockAgeMs(lockPath: string): Promise<number | undefined> {
  try {
    const stats = await stat(lockPath)
    return Date.now() - Math.floor(stats.mtimeMs)
  } catch {
    return undefined
  }
}
