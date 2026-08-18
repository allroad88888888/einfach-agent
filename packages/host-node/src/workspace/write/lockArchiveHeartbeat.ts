// 归档写锁的心跳：定期刷新锁文件，并且绝不拖住进程退出
// ---------------------------------------------------------------------------
// 对齐 apps/desktop/src/workspace_write_lock.rs 里那个心跳线程：每 5 秒把 token 原样重写回锁文件
// 开头（`seek(0)` + `write_all` + `flush`），写失败就自己结束、不重试也不上报。
//
// 心跳刷的其实是 **mtime**——接管判定看的就是它（lockArchiveRules 的 `isArchiveLockStale`）。
// 重写的内容与原来逐字节相同，所以刷新过程中任何时刻被别人读到的都是完整的 token，不存在
// 「读到半截」的窗口；这也是它敢用定位写而不是「截断再写」的原因。
//
// 【周期常量为什么不在 limits.ts】
// 因为 Rust 也没把它放进 workspace_write_limits.rs，而是写死在锁文件里。W5 移植的是那份常量表，
// 逐条对得上；这个 5 秒跟着它的原产地走，两边 grep 的结果才一致。
//
// 【unref 是硬要求】
// 一个 ref 着的周期定时器会让 Node 的 event loop 永远有事可做：CLI 宿主跑完一条命令后不退出，
// 表现是「回车之后光标停在那儿」，而且这个症状不指向锁、不指向写入、不指向任何病因。
// N3 的 `shell/deadline.ts` 因同一个理由每次都 clearTimeout，那里的理由写在文件头。
// 这里还多一层：`setInterval` 从 `node:timers` 显式导入，**不用全局的那个**——测试环境是 jsdom，
// 全局 `setInterval` 是 jsdom 的实现，返回的 number 上根本没有 `unref`，真调就是当场 TypeError。

import type { FileHandle } from 'node:fs/promises'
import { clearInterval, setInterval } from 'node:timers'

/** 心跳周期，与 Rust 的 `Duration::from_secs(5)` 一致。 */
export const ARCHIVE_LOCK_HEARTBEAT_MS = 5_000

export interface ArchiveLockHeartbeat {
  /** 停掉定时器。释放锁的第一步，且可以重复调用。 */
  stop(): void
  /**
   * 定时器是否还 ref 着 event loop。**只为测试存在**：漏掉 unref 在生产里的唯一表现是宿主
   * 不退出，没有别的可观测面，只能在这里钉住。
   */
  hasRef(): boolean
}

/**
 * 起一个心跳，把 `payload` 反复写回 `handle` 的 0 偏移处。
 *
 * `handle` 的所有权仍在调用方（`lockArchive.ts`）手上：心跳只用它，不负责关。停心跳与关句柄
 * 的先后由释放路径决定——反过来（先关句柄）会让最后一次心跳写到已关闭的 fd 上。
 */
export function startArchiveLockHeartbeat(
  handle: FileHandle,
  payload: Uint8Array,
  intervalMs: number = ARCHIVE_LOCK_HEARTBEAT_MS,
): ArchiveLockHeartbeat {
  const timer = setInterval(() => {
    // 写失败几乎只有一种原因：锁文件已被接管者改名删掉，或句柄被关了。对齐 Rust 心跳线程的
    // `break`——停掉自己就行。此处**不能**把错误抛出去：定时器回调里的异常会变成
    // unhandled rejection，把一次「锁没了」升级成整个进程崩溃。
    void handle.write(payload, 0, payload.length, 0).catch(() => clearInterval(timer))
  }, intervalMs)
  timer.unref()
  return {
    stop: () => clearInterval(timer),
    hasRef: () => timer.hasRef(),
  }
}
