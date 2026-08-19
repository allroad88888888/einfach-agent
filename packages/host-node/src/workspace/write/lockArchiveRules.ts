// 跨进程归档写锁的两条纯规则：锁文件叫什么、什么时候算陈旧
// ---------------------------------------------------------------------------
// 对齐 apps/desktop/src/workspace_write_lock.rs（已随 T1 删除）的 `archive_lock_path` 与
// `archive_lock_is_stale`，外加 stale 接管时那次 `with_extension(format!("stale-{token}"))`。
//
// 单独一个文件是因为这三条**不碰文件系统**：入参是路径字符串和两个时间数，出参是路径字符串和
// 一个 bool。W16/W17 要拿它们和 Rust 侧对拍，对拍不该顺带起一个真实的锁文件。
// 真正的抢占/心跳/接管/释放在 lockArchive.ts。

import { basename, dirname, extname, join } from 'node:path'

/** 锁文件后缀，与 Rust 逐字一致——两个宿主必须认得出对方留下的锁。 */
const ARCHIVE_LOCK_SUFFIX = '.archive-write.lock'

/**
 * 目标文件 → 它的锁文件路径（同目录的兄弟文件，`<名字>.archive-write.lock`）。
 *
 * 没有文件名的路径（根目录、`.`、`..` 结尾）要拒：对齐 Rust `Path::file_name()` 返回 None 的
 * 三种情形。实际调用点传进来的是 `resolveWriteTarget` 解析过的绝对路径，`..` 在那一层就被拒了，
 * 所以这条在流水线里够不着——留着是因为本函数是导出面，不能靠调用方的自觉来保证不越界。
 */
export function archiveLockPath(targetPath: string): string {
  const name = basename(targetPath)
  if (name === '' || name === '.' || name === '..') {
    throw new Error('archive path lock requires a file target')
  }
  return join(dirname(targetPath), `${name}${ARCHIVE_LOCK_SUFFIX}`)
}

/**
 * 接管一把陈旧锁时，先把它改名到这个路径再删——**不是**直接 unlink。
 *
 * 直接删会踩一个致命的窗口：两个等待者同时判定「陈旧」，A 删掉锁文件并立刻 create_new 建了
 * 自己的，B 的 unlink 慢一步执行，删掉的就是 **A 刚建好的那把锁**，于是两个进程同时以为自己
 * 持锁。改名把这一步变成有胜负的：目的地带各自的 token，一定不同名，谁的 rename 成功谁才算
 * 接管，输的那个拿到 ENOENT、回去继续轮询。
 *
 * 路径形状对齐 Rust 的 `with_extension`（**替换**最后一段扩展名而不是追加）：
 * `x.jsonl.archive-write.lock` → `x.jsonl.archive-write.stale-<token>`。
 */
export function archiveLockStalePath(lockPath: string, token: string): string {
  const extension = extname(lockPath)
  const stem = extension === '' ? lockPath : lockPath.slice(0, -extension.length)
  return `${stem}.stale-${token}`
}

/**
 * 锁文件多久没被心跳刷新才算「持有者已经死了、可以接管」。
 *
 * `ageMs` = 现在 - 锁文件 mtime，`staleMs` = 允许的最大静默。两条边角刻意与 Rust 对齐：
 *   · **未来的 mtime**（`ageMs < 0`，时钟回拨或 NFS 偏差）一律**不算陈旧**。Rust 那边是
 *     `modified.elapsed().ok()` 返回 Err、`is_some_and` 因此为 false；照搬它比自作主张更安全
 *     ——把一把刚被别人刷新过的锁判成陈旧，代价是两个进程同时写。
 *   · `staleMs === 0` 时**任何**非负年龄都算陈旧（Rust: `Duration::ZERO >= Duration::ZERO`）。
 *     这不是边角料，它是测试构造「立刻可接管的锁」的唯一入口。
 */
export function isArchiveLockStale(ageMs: number, staleMs: number): boolean {
  if (!Number.isFinite(ageMs) || ageMs < 0) return false
  return ageMs >= staleMs
}
