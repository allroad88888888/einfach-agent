// 严格 base64 解码：`encoding: "base64"` 的 content → 字节
// ---------------------------------------------------------------------------
// 逐字对齐 apps/desktop/src/workspace_write_base64.rs 的 `decode_base64`（标准 RFC 4648 alphabet，
// `+` `/`，**不是** URL-safe 的 `-` `_`；padding 允许省略，但省略之后长度约束仍要满足）。
//
// ⚠️ **不能用 `Buffer.from(x, 'base64')` 顶**：它对非法字符是静默跳过，`"not base64!"` 会被解成
// 一串垃圾字节直接写进磁盘——比拒绝糟得多。这里选择的做法是**逐字符移植 Rust 的状态机**而不是
// 「正则校验一遍再丢给 Buffer.from」或「解码后 round-trip 比对」：状态机在解码的同时校验，天然不
// 存在「校验通过了但解码用了另一套更宽松的规则」这种两遍逻辑对不齐的空子，且错误文案（哪个字符、
// 哪种 padding 问题）与 Rust 逐字一致，不是移植后另起一套。
//
// 【与 Rust 的一处必然差异，且无害】Rust 按 UTF-8 字节遍历，一个非 ASCII 字符在源里是多个字节，
// 报错会指向其中一个字节；这里按 JS 字符串的 UTF-16 code unit 遍历（不用 `Array.from` 拆代理对，
// 8 MiB 级输入下逐字符物件化的开销不值得），报错指向的是那个 code unit。base64 的合法字母表本就
// 是纯 ASCII，非 ASCII 输入无论哪种遍历方式都会落在「unexpected character」分支，只是错误文案里
// 展示的字符表示可能不同——这从不影响「合法输入解出正确字节、非法输入被拒」这条契约。

import { rejectWrite } from './result'

const EQUALS_CODE = 0x3d // '='

/** Rust `u8::is_ascii_whitespace`：只认这五个，不含 `\v`（0x0B）——传输中的换行是合法 padding。 */
function isAsciiWhitespaceCode(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20
}

/** RFC 4648 标准 alphabet（`+` `/`），非法字符返回 `undefined`。 */
function base64ValueForCode(code: number): number | undefined {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41 // A-Z
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26 // a-z
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52 // 0-9
  if (code === 0x2b) return 62 // +
  if (code === 0x2f) return 63 // /
  return undefined
}

/** 报错里展示的字符：可打印 ASCII 原样展示，其余给一个 Rust `escape_default` 风格的转义。 */
function describeChar(code: number): string {
  if (code >= 0x20 && code <= 0x7e) return String.fromCharCode(code)
  if (code === 0x09) return '\\t'
  if (code === 0x0a) return '\\n'
  if (code === 0x0d) return '\\r'
  return `\\u{${code.toString(16)}}`
}

/**
 * 把 base64 文本解成字节。解不出来即按设计拒绝（`WriteRejection`），磁盘一个字节都不碰。
 *
 * 三条判据逐字对齐 Rust：
 *   1. padding 只能省略、或以 1/2 个 `=` 结尾；出现 3 个及以上、或「有 padding 但总长不是 4 的
 *      倍数」都是「malformed padding」——而不是静默按 4 的倍数截断或补齐。
 *   2. body 里任何不在 alphabet 里的字符（含出现在非末尾位置的 `=`）都是「unexpected character」。
 *   3. 解码结束后剩余的累积位数 ≥ 6，或剩余位不全为 0（截断导致最后一组凑不出完整字节，或非零
 *      的“隐藏”比特被截掉），都是「truncated input」。
 */
export function decodeBase64(input: string): Uint8Array {
  const symbols: number[] = []
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (!isAsciiWhitespaceCode(code)) symbols.push(code)
  }

  const len = symbols.length
  let paddingCount = 0
  if (len >= 2 && symbols[len - 1] === EQUALS_CODE && symbols[len - 2] === EQUALS_CODE) {
    paddingCount = 2
  } else if (len >= 1 && symbols[len - 1] === EQUALS_CODE) {
    paddingCount = 1
  }
  const bodyLen = len - paddingCount

  if (paddingCount > 2 || (len % 4 !== 0 && paddingCount > 0)) {
    rejectWrite('content is not valid base64: malformed padding')
  }

  // 与 Rust 的 `Vec::with_capacity(body.len() / 4 * 3 + 3)` 同一个安全上界：真实产出从不会超过它。
  const output = new Uint8Array(Math.floor(bodyLen / 4) * 3 + 3)
  let outputLength = 0
  let accumulator = 0
  let bits = 0
  for (let i = 0; i < bodyLen; i++) {
    const decoded = base64ValueForCode(symbols[i])
    if (decoded === undefined) {
      rejectWrite(`content is not valid base64: unexpected character \`${describeChar(symbols[i])}\``)
    }
    // `>>> 0` 把结果钉在无符号 32 位：位运算本身已按 32 位截断，这里只是不让後续比较被当成负数读岔。
    accumulator = ((accumulator << 6) | decoded) >>> 0
    bits += 6
    if (bits >= 8) {
      bits -= 8
      output[outputLength] = (accumulator >>> bits) & 0xff
      outputLength++
    }
  }

  // 收尾的残余位：≥6 位凑不出完整字节（比如单个字符只剩 6 位）；不足 6 位时必须全为 0，
  // 否则说明输入在字节边界内被截断，残留了本不该存在的非零比特。
  if (bits >= 6 || (accumulator & ((1 << bits) - 1)) !== 0) {
    rejectWrite('content is not valid base64: truncated input')
  }

  return output.subarray(0, outputLength)
}
