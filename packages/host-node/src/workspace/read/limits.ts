// workspace/read 域的容量上限与取值归一化
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_read_limits.rs，数字逐个照搬——这些值同时出现在工具的
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
