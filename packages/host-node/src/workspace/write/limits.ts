// write 域的数值预算：逐字照搬 apps/desktop/src/workspace_write_limits.rs，不自己定
// ---------------------------------------------------------------------------
// 本文件只有常量表，没有判定——按这些常量做的判定在 limitChecks.ts。分开是因为这张表的读法是
// 「与 Rust 那 20 行逐条对照」，而判定要读的是「什么时候、拿什么去比」，两件事。
//
// 时长在 Rust 侧是 `Duration`，Node 侧一律毫秒数，名字带 `_MS` 后缀把单位写在脸上——
// `setTimeout(ARCHIVE_LOCK_WAIT)` 传进去一个「10」而不是 10 秒，是这类移植的经典错法。
// 其余常量的名字与 Rust 逐字一致，方便两边 grep 对照。

/**
 * 单次写入的硬上限（8 MiB）。
 *
 * `maxBytes` 已经不在模型可见的 schema 里了，所以「没传」意味着**取最大值**而不是取一个更小的
 * 默认值——在这里悄悄压低，会把工具层已经接受的写入在宿主里默默拒掉。
 */
export const MAX_BYTES = 8 * 1024 * 1024

/**
 * 可逆预算（1 MiB）。回滚要在变更日志里存下完整的前后文本，所以「能不能撤销」的预算比「能不能
 * 写」紧得多。超过它的写入**仍然成功**，只是 `reversible: false` 并给出理由，不是失败。
 */
export const REVERSIBLE_MAX_BYTES = 1024 * 1024

/** 进程内按目标路径缓存的互斥锁数量超过这个值时清扫一次缓存（W6 用）。 */
export const PATH_LOCK_SWEEP_THRESHOLD = 1024

/** 跨进程锁文件的最长等待时间（W6 用）。 */
export const ARCHIVE_LOCK_WAIT_MS = 10_000

/** 锁文件多久没心跳就算陈旧、可以被接管（W6 用）。 */
export const ARCHIVE_LOCK_STALE_MS = 30_000

/** 等锁时的轮询间隔（W6 用）。 */
export const ARCHIVE_LOCK_POLL_MS = 20

/** 子 Agent 归档索引小于这个大小就不值得压缩（W9 用）。 */
export const INDEX_COMPACT_MIN_BYTES = 128 * 1024

/** 两次自动压缩之间的最小间隔（W9 用）。 */
export const INDEX_COMPACT_THROTTLE_MS = 5 * 60 * 1000

/** 索引大到这个程度就不再自动压缩，改为报错要求人工处理（W9 用）。 */
export const INDEX_COMPACT_MAX_BYTES = 16 * 1024 * 1024
