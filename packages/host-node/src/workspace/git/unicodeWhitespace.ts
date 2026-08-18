// Rust 的 `str::trim` / `char::is_whitespace` / `char::is_control` 在 JS 里的等价物
// ---------------------------------------------------------------------------
// `workspace_git_args.rs` 与 `workspace_git_path.rs` 都先 `trim()` 再判字符类别，两处必须用
// **同一套**判据，否则「参数层拒了、路径层放了」这种缝就是从这里裂开的。
//
// 为什么不用 `String.prototype.trim()`：它的空白集合与 Rust 的 White_Space 属性**不相等**——
// JS 额外修剪 U+FEFF（BOM，Unicode 里不是 White_Space）。差别在 base 上是「JS 静默修好了一个
// 带 BOM 的 ref，Rust 让它去 rev-parse 那里失败」，在 pathspec 上是「JS 匹配到了真实文件，
// Rust 匹配到空」——都不算漏洞，但两个宿主对同一次调用给出不同结果，那正是移植要避免的事。

/** `\p{Cc}` 就是 Rust `char::is_control` 的定义（general category Cc）。 */
const WHITESPACE_OR_CONTROL = /[\p{White_Space}\p{Cc}]/u
const WHITESPACE_PREFIX = /^\p{White_Space}+/u
const WHITESPACE_SUFFIX = /\p{White_Space}+$/u

/** 等价 Rust 的 `str::trim`（按 White_Space 属性修剪首尾）。 */
export function trimUnicodeWhitespace(value: string): string {
  return value.replace(WHITESPACE_PREFIX, '').replace(WHITESPACE_SUFFIX, '')
}

/** 串里是否含 Unicode 空白或控制字符。 */
export function hasWhitespaceOrControl(value: string): boolean {
  return WHITESPACE_OR_CONTROL.test(value)
}
