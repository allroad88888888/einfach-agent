// 按 Unicode 码点计数与截取
// ---------------------------------------------------------------------------
// 带上限的增量读要跟 Rust 的上限**是同一个上限**：Rust 数的是 `chars()`，即 Unicode 标量值；
// JS 的 `String.length` 数的是 UTF-16 码元，一个 emoji 算 2、一个中日韩汉字算 1。直接用
// `.length` 会让同一份输出在两个宿主下截在不同位置，而这种差异只在含 emoji/生僻字的输出里
// 才现形——正是最难复现的那类 bug。
//
// 不用 `[...text].length` / `Array.from(text)`：那会为每个码点分配一个字符串对象，而这两个
// 函数是在**每一个读进来的块**上跑的。手写一遍代理对判定，零分配。

/** 码点个数。等价 Rust 的 `text.chars().count()`。 */
export function countCodePoints(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (isHighSurrogateAt(text, index)) index += 1
    count += 1
  }
  return count
}

/** 取前 `limit` 个码点。等价 Rust 的 `text.chars().take(limit)`——绝不把代理对切一半。 */
export function takeCodePoints(text: string, limit: number): string {
  if (limit <= 0) return ''
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (isHighSurrogateAt(text, index)) index += 1
    count += 1
    if (count === limit) return text.slice(0, index + 1)
  }
  return text
}

/** `index` 处是不是一个完整代理对的高位（尾随低位存在才算，孤立高位按单个码点处理）。 */
function isHighSurrogateAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index)
  if (code < 0xd800 || code > 0xdbff || index + 1 >= text.length) return false
  const next = text.charCodeAt(index + 1)
  return next >= 0xdc00 && next <= 0xdfff
}
