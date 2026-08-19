// 补丁文本输入的大小与二进制上限
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_patch_limits.rs（已随 T1 删除）整份。纯函数，不碰文件系统。
//
// 这里只管**入参与算出来的结果文本**；「磁盘上那个文件多大」由 W13 的 fs 那层用同一个
// `MAX_FILE_BYTES` 判（Rust 的 `read_optional_text_file` 就是这么用的），文案不同
// （那边是 `file exceeds N byte limit`，没有 label）。
//
// patch 的上限是 **1 MiB**，与 write 域的 8 MiB 硬顶不是一回事：补丁要把整个文件读进内存、
// 在内存里做替换、还要把改动前后两份都塞进变更日志，1 MiB 是「可逆」那条线。

/** 单份补丁文本的字节上限（1 MiB）。 */
export const MAX_FILE_BYTES = 1024 * 1024

/** 不许为空的文本入参（当前只有 `oldText`：空串会匹配到无穷多个位置）。 */
export function validateNonEmptyTextInput(label: string, value: string): void {
  if (value.length === 0) throw new Error(`${label} must be non-empty`)
  validateTextInput(label, value)
}

/**
 * 文本入参的两条上限：字节数与「像不像二进制」。
 *
 * **必须用 `Buffer.byteLength` 而不是 `.length`**：Rust 的 `value.as_bytes().len()` 是字节数，
 * 直译成 `.length` 会让 1.2 MB 的中文正文被判成没超 1 MiB 而放行（W5 在 write 域踩过同一个坑）。
 */
export function validateTextInput(label: string, value: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_FILE_BYTES) {
    throw new Error(`${label} exceeds ${MAX_FILE_BYTES} byte limit`)
  }
  if (value.includes('\0')) throw new Error(`${label} appears to be binary`)
}

/**
 * 校验**替换之后**的整份文件文本。规则与入参完全相同（Rust 的 `validate_file_text` 就是
 * `validate_text_input` 的转发），单独留一个名字是因为 label 不一样：调用点传的是
 * `resulting file content`，模型据此能分清「你给的 newText 太大」和「替换完之后文件太大」。
 */
export function validateFileText(label: string, value: string): void {
  validateTextInput(label, value)
}
