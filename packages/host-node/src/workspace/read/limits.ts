// workspace/read 域的容量上限与取值归一化
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_read_limits.rs（已随 T1 删除），数字逐个照搬——这些值同时出现在工具的
// 提示词与模型的续读逻辑里，改动一个就是改了模型看到的世界。
//
// 本文件只放**字节读取路径**用得上的四个上限（W1）。行定位（W2）复用 MAX_HASH_BYTES 与
// DEFAULT/MAX_READ_BYTES；列举、搜索、run index 分页（W3/W4）那批常量（DEFAULT_LIST_MAX_ENTRIES、
// MAX_SEARCH_* 、EXCLUDED_DIR_NAMES、RUNS_INDEX_PATH…）落地时加到这里，同一份 Rust 文件对同
// 一个 Node 文件。

/** 调用方没给 maxBytes 时的单次读取量。 */
export const DEFAULT_READ_MAX_BYTES = 20_000

/** 普通文件单次读取的硬上限，调用方给再大也钳到这里。 */
export const MAX_READ_BYTES = 200_000

/**
 * contentHash 的计算上限（8 MiB）。
 *
 * 哈希的唯一用途是给 write_file / apply_patch 当乐观锁，所以只对它们真的能整体覆盖的大小
 * 计算——上限对齐 write_file。更大的文件即使给出哈希也没有工具能用它做覆盖，白扫一遍全文
 * 没有意义。
 */
export const MAX_HASH_BYTES = 8 * 1024 * 1024

/**
 * 归档轨迹文件的放宽上限。完整轨迹只在选中单个子 agent 时读取，因此仅对
 * `.webAgent-archive/traces/*.trace.jsonl` 放宽显式读取上限。
 */
export const MAX_TRACE_READ_BYTES = 2_000_000

/** run index 分页：调用方没给 maxRecords 时一页的条数。 */
export const DEFAULT_RUN_INDEX_PAGE_RECORDS = 50

/** run index 分页：单页条数硬上限。 */
export const MAX_RUN_INDEX_PAGE_RECORDS = 500

/** run index 文件整体大小上限（16 MiB）；超过就整体拒绝，不做分段读取。 */
export const MAX_RUN_INDEX_BYTES = 16 * 1024 * 1024

/** 子 Agent 归档的 run 索引文件，workspace 根相对、固定路径（不是调用方可传的参数）。 */
export const RUNS_INDEX_PATH = '.webAgent-archive/index/runs.jsonl'

/** `list_workspace_files`：调用方没给 maxEntries 时的条目上限。 */
export const DEFAULT_LIST_MAX_ENTRIES = 200

/** `list_workspace_files`：单次调用条目数硬上限，调用方给再大也钳到这里。 */
export const MAX_LIST_ENTRIES = 2_000

/** `search_workspace_files`：调用方没给 maxMatches 时的命中上限。 */
export const DEFAULT_SEARCH_MAX_MATCHES = 100

/** `search_workspace_files`：单次调用命中数硬上限。 */
export const MAX_SEARCH_MATCHES = 1_000

/** 单个文件参与内容匹配的字节上限；超出部分不读，且整体结果记为 truncated。 */
export const MAX_SEARCH_FILE_BYTES = 1_000_000

/** 命中行回显的码点数上限（等价 Rust `chars()` 计数，不是 UTF-16 code unit）。 */
export const MAX_SEARCH_LINE_CHARS = 1_000

/**
 * P2 遍历预算：query 少见/无匹配时 maxMatches 永远不会触发，会遍历整棵树（node_modules/target）
 * 独占进程。跨整棵递归共享的已扫描目录条目计数，达到此上限即停并置 truncated。
 */
export const MAX_SEARCH_SCANNED_ENTRIES = 20_000

/**
 * P2 排除常见重目录：整个跳过、不递归进去。`.git` / `.next` 等隐藏目录本就被 `isHidden` 挡住，
 * 这里再显式列一遍并覆盖 `node_modules` / `target` / `dist` 等非隐藏的重目录。
 */
export const EXCLUDED_DIR_NAMES: readonly string[] = [
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  'vendor',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
]

/**
 * 等价 Rust 的 `normalize_positive`：`Some(v) if v > 0 => v.min(max)`，否则回落默认值。
 *
 * **0 不是「不限」，是「没有有效值」**——它和「没传」一样回落到 `fallback`。
 * 入参已经过 handler 收窄（非负整数才会到这里），负数/小数/非数在那一步就变成了 undefined：
 * Rust 侧那些非法值在 Tauri 的 deserialize 阶段就被挡掉，Node 侧没有那道关卡，收窄即是补它。
 */
export function normalizePositive(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined || value <= 0) return fallback
  return Math.min(value, max)
}
