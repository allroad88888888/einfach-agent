// rg 域的六个常量：逐字照搬 apps/desktop/src/workspace_rg.rs（已随 T1 删除）顶部，不自己定
// ---------------------------------------------------------------------------
// 上限的钳制方向（读 Rust 侧 normalize_context_lines / normalize_max_matches 确认过）：
//   · context_lines —— 调用方传超过 MAX_CONTEXT_LINES 的值时**钳到上限**（`.min(MAX)`），
//     不是拒绝整个请求。
//   · max_matches —— 同样是**钳到上限**（`value.min(MAX_MATCHES)`）；传 0 或不传都退回默认值，
//     不是「0 表示不限」。

/** 不传 max_matches 时的默认命中上限。 */
export const DEFAULT_RG_MAX_MATCHES = 200

/** max_matches 允许的最大值；调用方传更大的值会被钳到这里，而不是拒绝请求。 */
export const MAX_RG_MATCHES = 1_000

/** 不传 context_lines 时的默认上下文行数。 */
export const DEFAULT_RG_CONTEXT_LINES = 0

/** context_lines 允许的最大值；调用方传更大的值会被钳到这里。 */
export const MAX_RG_CONTEXT_LINES = 5

/** rg stderr 保留的最大码点数，超出部分读了就丢（见 readCappedDrain）。 */
export const MAX_RG_STDERR_CHARS = 10_000

/** 传给 rg 的 `--max-filesize`：超过这个大小的文件 rg 自己跳过，不进我们的进程内存。 */
export const RG_MAX_FILESIZE = '1M'
