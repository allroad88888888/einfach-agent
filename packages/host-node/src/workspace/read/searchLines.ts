// `search_workspace_files` 的按行切分：等价 Rust `str::lines()`，不是 W2 的 `split_inclusive`
// ---------------------------------------------------------------------------
// W2（linesRead.ts 的 `lineBoundaries`）复刻的是 Rust `str::split_inclusive('\n')`——那条路径要
// 把内容原样拼回磁盘字节（apply_patch 的 oldText），因此保留换行符、`\r` 留在行内容里不剥离。
// 这里对齐的是另一个不同的 Rust 迭代器 `str::lines()`（workspace_read_search.rs 的
// `content.lines()`），只用于按行做子串匹配，语义不同、不能共用那份实现：
//
//   1. **空文本是 0 行**，不是 1 行——与 W2 同一个 JS 陷阱（`''.split('\n')` 给 `['']`），
//      但 `str::lines()` 自己也在这一点上与 `split_inclusive` 不同：后者对 `''` 同样是 0 段，
//      两者在这一条上凑巧一致，此处仍需要显式特判，不能假设「跟 W2 一样处理就对」。
//   2. **末尾的换行符不产生多余空行**：`"a\n"` 与 `"a"` 都是 1 行 `["a"]`；只有紧跟在字符串
//      结尾的那一个 `\n` 被这样处理，行中间的空行（`"a\n\nb"` 的第二行）照常保留。
//   3. **`\r\n` 的 `\r` 被剥离**：每一段按 `\n` 切出来之后，若以 `\r` 结尾就去掉那一个字符；
//      不是 `\r\n` 组合以外场景出现的孤立 `\r`（比如行中间）不受影响。
//
// 三条规则组合的效果：先按 `\n` 整体 split，**若原文本以 `\n` 结尾就丢弃 split 结果里最后那个
// （必然是空串的）元素**，再对每一段单独剥尾部 `\r`。

/** 等价 Rust `text.lines().collect::<Vec<_>>()`。 */
export function splitContentLines(text: string): string[] {
  if (text === '') return []
  const parts = text.split('\n')
  if (text.endsWith('\n')) parts.pop()
  return parts.map((part) => (part.endsWith('\r') ? part.slice(0, -1) : part))
}
