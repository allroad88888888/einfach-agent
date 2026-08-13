//! workspace 读取路径的容量上限常量与取值归一化。

pub(super) const DEFAULT_READ_MAX_BYTES: usize = 20_000;
pub(super) const MAX_READ_BYTES: usize = 200_000;
// contentHash 的唯一用途是给 write_file / apply_patch 当乐观锁，所以只对它们真的能整体
// 覆盖的大小计算——上限对齐 write_file。更大的文件即使给出哈希也没有工具能用它做覆盖，
// 白扫一遍全文没有意义。
pub(super) const MAX_HASH_BYTES: u64 = 8 * 1024 * 1024;
// 完整轨迹只在选中单个子 agent 时读取，因此仅对归档轨迹目录放宽显式读取上限。
pub(super) const MAX_TRACE_READ_BYTES: usize = 2_000_000;
pub(super) const DEFAULT_RUN_INDEX_PAGE_RECORDS: usize = 50;
pub(super) const MAX_RUN_INDEX_PAGE_RECORDS: usize = 500;
pub(super) const MAX_RUN_INDEX_BYTES: usize = 16 * 1024 * 1024;
pub(super) const RUNS_INDEX_PATH: &str = ".webAgent-archive/index/runs.jsonl";
pub(super) const DEFAULT_LIST_MAX_ENTRIES: usize = 200;
pub(super) const MAX_LIST_ENTRIES: usize = 2_000;
pub(super) const DEFAULT_SEARCH_MAX_MATCHES: usize = 100;
pub(super) const MAX_SEARCH_MATCHES: usize = 1_000;
pub(super) const MAX_SEARCH_FILE_BYTES: usize = 1_000_000;
pub(super) const MAX_SEARCH_LINE_CHARS: usize = 1_000;
// P2 搜索遍历预算：query 少/无匹配时 max_matches 永不触发，会遍历整棵树（node_modules/target）
// 独占 blocking worker。扫描的目录条目数达此上限即停并置 truncated。
pub(super) const MAX_SEARCH_SCANNED_ENTRIES: usize = 20_000;
// P2 排除常见重目录：整个跳过、不递归进去（.git/.next 等隐藏目录本就被 is_hidden 跳过，
// 这里再显式列一遍并覆盖 node_modules/target/dist 等非隐藏的重目录）。
pub(super) const EXCLUDED_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "coverage",
    ".next",
    ".turbo",
    ".cache",
];

pub(super) fn normalize_positive(value: Option<usize>, fallback: usize, max: usize) -> usize {
    match value {
        Some(value) if value > 0 => value.min(max),
        _ => fallback,
    }
}
