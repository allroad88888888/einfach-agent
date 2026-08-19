// 进程内按目标路径的写入互斥
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_write_lock.rs（已随 T1 删除）的 `path_lock`：一张
// `PathBuf → Arc<Mutex<()>>` 的表，同一路径的并发写在本进程内排队；表超过阈值时扫掉没人持有
// 的条目。跨进程的竞争（外部编辑器、另一个宿主进程）不归它管，那是 lockArchive.ts 的事。
//
// 【Node 是单线程，为什么还要一把锁】
// 因为写入流水线的临界区不是一条同步语句，而是**跨了好几次 await** 的「读—验证—写」：
//
//     读 before ──await──▶ 乐观守卫比 hash ──▶ 记回滚日志 ──await──▶ atomicWrite
//
// 两个并发的 `write_workspace_file` 打同一个路径时，A 在第一次 await 处让出，B 整段跑完并把
// 文件换成了新内容；A 恢复后拿着**它自己那次读到的** before 去比守卫 —— 比的是过期快照，
// 当然通过 —— 然后 atomicWrite 整份覆盖，B 刚写进去的内容一声不响地没了。
// 守卫存在的全部意义就是拦「你读完之后有人改过」，而没有这把锁时它恰恰只会拿自己的旧读数
// 自证清白。单线程消掉的是数据竞争，消不掉这种交错。
// 同一条判断 N7 为配置写入做过一次（`config/webAgentConfigStore.ts` 的 `withConfigLock`），
// 那里是全局一条队列，这里必须按路径分桶：写两个不同文件本来就该并行。
//
// 【为什么不干脆按 Rust 那样返回一把锁让调用方自己 lock】
// Rust 的 `Arc<Mutex<()>>` 靠 guard 的 Drop 释放，忘了持有 guard 编译器会提醒；JS 没有这层
// 保护，`acquire()` / `release()` 成对写在两处，任何一条 early return 都能漏掉 release，从此
// 该路径永久死锁。收成 `run(key, operation)` 之后，释放由本文件负责，调用方漏不掉。

import { PATH_LOCK_SWEEP_THRESHOLD } from './limits'

interface PathLockEntry {
  /**
   * 队尾。下一个进入临界区的操作 await 它。
   * 永远是一条**已吞掉失败**的链：前一次写抛错不该让后面排队的写全部跟着失败。
   */
  tail: Promise<unknown>
  /**
   * 正在排队或正在执行的操作数。
   * 对应 Rust 里 `Arc::strong_count(lock) > 1` 那半句：0 = 此刻无人持有，扫除时可以删。
   */
  holders: number
}

/** 一张独立的锁表。生产只用模块级那一张；`createPathLockTable()` 给测试一张干净的。 */
export interface PathLockTable {
  /** 在 `key` 的临界区里跑 `operation`，同 key 的调用严格排队，不同 key 互不相干。 */
  run<T>(key: string, operation: () => Promise<T>): Promise<T>
  /** 当前表里的条目数。存在的理由只有一个：扫除本身在外部不可观测，测试需要它才钉得住。 */
  readonly size: number
}

export function createPathLockTable(): PathLockTable {
  const entries = new Map<string, PathLockEntry>()

  /**
   * 取 `key` 的条目，顺带在表太大时扫一遍。
   *
   * 路径是无界的（每写一个新文件就多一个 key），不扫就是纯粹的内存泄漏——这也是 Rust 侧
   * 有 `PATH_LOCK_SWEEP_THRESHOLD` 的全部理由，阈值直接用 W5 移植好的那个常量。
   * `holders === 0` 的条目一定可以删：它的 `tail` 已经 settle，队里没有任何等待者，
   * 下一次访问同一路径会新建一条，语义完全一样。
   *
   * 刻意**不**在每次释放时立刻删条目：那样表恒等于在途写入数，看似更省，但会让「删条目」
   * 落在每一次写入的收尾路径上，而收尾路径正是并发窗口最刁钻的地方（holders 归零与下一个
   * 调用者取到旧条目之间只隔一个微任务）。阈值扫除把清理挪到**取条目**这一侧——那里本来
   * 就是同步的、没有 await 的一段，判据只有一个 `holders === 0`。
   */
  function acquire(key: string): PathLockEntry {
    if (entries.size > PATH_LOCK_SWEEP_THRESHOLD) {
      for (const [candidate, entry] of entries) {
        if (entry.holders === 0) entries.delete(candidate)
      }
    }
    const existing = entries.get(key)
    if (existing !== undefined) return existing
    const created: PathLockEntry = { tail: Promise.resolve(), holders: 0 }
    entries.set(key, created)
    return created
  }

  return {
    run<T>(key: string, operation: () => Promise<T>): Promise<T> {
      const entry = acquire(key)
      // holders 在**排队时**就加，不是开跑时才加：等待中的调用者也算持有者，否则扫除会把
      // 一条还有人排队的条目删掉，后来者新建一条空队列，两边就并行了。
      entry.holders += 1
      // 两个分支都接 `operation`：前一次成功还是失败，都不改变「轮到我了」这件事。
      const running = entry.tail.then(operation, operation)
      const release = (): void => {
        entry.holders -= 1
      }
      entry.tail = running.then(release, release)
      return running
    },
    get size(): number {
      return entries.size
    },
  }
}

/** 进程级唯一的锁表，对应 Rust 的 `static LOCKS: OnceLock<...>`。 */
const processPathLocks = createPathLockTable()

/**
 * 在 `absolutePath` 的进程内写锁下跑 `operation`。
 *
 * **key 必须是已解析的绝对路径**（`resolveWriteTarget` 的 `absolutePath`）：同一个文件的两种
 * 写法会落到两条队列上，锁等于没上。Rust 侧同样是拿 `target_path` 当键，不是拿请求里的原串。
 */
export function withPathLock<T>(absolutePath: string, operation: () => Promise<T>): Promise<T> {
  return processPathLocks.run(absolutePath, operation)
}
