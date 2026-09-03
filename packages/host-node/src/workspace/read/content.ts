// 读到的字节流：二进制判定与 UTF-8 解码
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_read_content.rs（已随 T1 删除）的两个解码函数。字节模式（W1）与行模式（W2）
// 共用；Rust 那份里还有一个 `cap_chars`，它是给搜索结果截行用的字符串工具、与「字节流」无关，
// 落到 W3 时另找去处，不塞进这里。
//
// 【解码：TextDecoder 的两处默认值都必须显式改掉】
// 目标语义是 Rust 的 `std::str::from_utf8` 三分支（全合法 / 尾部截断 / 真非法）：
//   · `fatal: true` —— 默认的替换字符模式会把非法字节悄悄变成 `�` 而不是失败，那样
//     「拒读非 UTF-8 文件」这条契约就没了。
//   · `ignoreBOM: true` —— **名字是反的**：默认（false）会把开头的 U+FEFF 当 BOM **吃掉**，
//     而 Rust 原样保留它。带 BOM 的文件因此会在 Node 侧少 3 个字节，`bytes` / `nextOffset`
//     跟着错位，续读从错误的位置开始。设成 true 才是「不当 BOM 特殊对待」。
// 「尾部不完整序列」用流式解码识别：`decode(bytes, {stream: true})` 把块尾不完整的多字节序列
// 留在 decoder 里（返回的正是 Rust 的 `valid_up_to()` 那一段），随后的 `decode()` 收尾时它若
// 仍不完整就抛——等价 Rust 的 `err.error_len().is_none()`。这套等价关系跑过一次差分测试：
// 4060 个样本（边界用例 + 伪随机字节串 + 一个多语言串的每一个截断点）两边分类与
// `valid_up_to` 字节数全等。

/**
 * 含 NUL 字节即判定为二进制并拒读。等价 Rust 的 `reject_binary_bytes`。
 *
 * 判定只针对**要返回的这一段**，不是整个文件：否则文件尾部的非文本内容会让一次合法的首段
 * 读取整体失败。
 */
export function rejectBinaryBytes(bytes: Uint8Array, displayPath: string): void {
  if (bytes.includes(0)) {
    throw new Error(`refusing to read binary file \`${displayPath}\``)
  }
}

/**
 * UTF-8 解码，等价 Rust 的 `decode_utf8`。
 *
 * `allowIncompleteTail` 为真（本段是被 maxBytes 截出来的）时，尾部那个被切断的多字节序列
 * 被丢弃、只返回它前面的合法部分——调用方据返回内容的字节长度算 `nextOffset`，下一段正好从
 * 那个被切断的字符开头续上，**分页因此无损**。为假（读到了文件真正的结尾）时，同样的残缺
 * 尾部说明这个文件本身就不是合法 UTF-8，按非法处理。
 */
export function decodeUtf8(
  bytes: Uint8Array,
  allowIncompleteTail: boolean,
  displayPath: string,
): string {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let head: string
  try {
    head = decoder.decode(bytes, { stream: true })
  } catch {
    // 中途就有非法字节：Rust 的 `error_len()` 是 Some(..)，两边都直接拒。
    throw new Error(nonUtf8Message(displayPath))
  }

  try {
    return head + decoder.decode()
  } catch {
    if (allowIncompleteTail) return head
    throw new Error(nonUtf8Message(displayPath))
  }
}

function nonUtf8Message(displayPath: string): string {
  return `refusing to read non-UTF-8 file \`${displayPath}\``
}
