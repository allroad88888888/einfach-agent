//! workspace 写入路径的数值预算：写入上限、可逆上限、锁与索引压缩的节流常量。

use std::time::Duration;

/// Hard ceiling on a single write. `max_bytes` is no longer part of the model-facing
/// schema, so an absent value means "the maximum", not a smaller default — capping it
/// lower here would silently reject writes the tool layer already accepted.
pub(super) const MAX_BYTES: usize = 8 * 1024 * 1024;
/// Rollback stores full before/after text in the journal, so reversibility has a much
/// tighter budget than the write itself. Past this a write still succeeds, but reports
/// `reversible: false` instead of failing.
pub(super) const REVERSIBLE_MAX_BYTES: usize = 1024 * 1024;
/// Path locks are cached per target; sweep the cache once it grows past this.
pub(super) const PATH_LOCK_SWEEP_THRESHOLD: usize = 1024;
pub(super) const ARCHIVE_LOCK_WAIT: Duration = Duration::from_secs(10);
pub(super) const ARCHIVE_LOCK_STALE: Duration = Duration::from_secs(30);
pub(super) const ARCHIVE_LOCK_POLL: Duration = Duration::from_millis(20);
pub(super) const INDEX_COMPACT_MIN_BYTES: u64 = 128 * 1024;
pub(super) const INDEX_COMPACT_THROTTLE: Duration = Duration::from_secs(5 * 60);
pub(super) const INDEX_COMPACT_MAX_BYTES: u64 = 16 * 1024 * 1024;
