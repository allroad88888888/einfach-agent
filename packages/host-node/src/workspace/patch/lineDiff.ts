// 行切分与 LCS 行级 diff
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_common.rs 的 `diff_lines` / `DiffTag`，外加 Rust
// `str::lines()` 的语义（TS 没有等价物，`split('\n')` 直译会多出一行）。
//
// **纯函数，一行 IO 都没有。** 这是 W16 跨语言对拍要拿的形状之一：同一对文本喂进去，两个宿主
// 得到逐条相同的编辑序列。
//
// 【为什么不用现成的 diff 库】
// 对拍的判据是「与 Rust 那份实现逐字相同」，而不是「diff 得好看」。任何库都会在 Myers/直方图/
// 补丁上下文这些地方给出不同但同样合理的结果，那时分不清是移植错了还是库不同。

/** 一条编辑的类型。marker 就是它在 unified diff 里的行首字符。 */
export type DiffTag = 'keep' | 'add' | 'remove'

export interface DiffEdit {
  tag: DiffTag
  line: string
}

/** 行首标记，与 Rust `DiffTag::marker()` 一一对应。 */
export function diffMarker(tag: DiffTag): string {
  if (tag === 'add') return '+'
  if (tag === 'remove') return '-'
  return ' '
}

/**
 * 等价 Rust 的 `str::lines()`：按 `\n` 切、**结尾的换行不产生空行**、`\r\n` 的 `\r` 剥掉。
 *
 * 四处直译就会错：
 *   · `"a\n".split('\n')` 给 `["a", ""]`，Rust 给 `["a"]`——多出来的那个空行会让每个以换行结尾的
 *     文件都凭空多一行，`beforeLines` / `afterLines` 全体偏 1。
 *   · `"".split('\n')` 给 `[""]`，Rust 给 `[]`——空文件应该是 0 行。
 *   · CRLF 文本不去 `\r` 的话，同一份内容的 LF 版与 CRLF 版会被判成每一行都变了。
 *   · **只有真的位于换行符之前的 `\r` 才剥**。Rust 的实现是先 `strip_suffix('\n')`，失败就整段
 *     原样返回，所以末行没有换行符时它结尾的 `\r` 属于内容：`"a\r"` 是一行 `"a\r"`，不是 `"a"`。
 *     无条件剥的后果是「以 `a\r` 结尾（无换行）」与「以 `a` 结尾」被判成同一份内容——一次真实的
 *     改动因此从 diff 里消失。
 */
export function splitLines(value: string): string[] {
  if (value.length === 0) return []
  const segments = value.split('\n')
  // 只有「结尾就是换行」才会留下这个空片段，此时它不算一行。
  const endsWithNewline = segments[segments.length - 1] === ''
  if (endsWithNewline) segments.pop()
  const last = segments.length - 1
  return segments.map((line, index) =>
    (endsWithNewline || index < last) && line.endsWith('\r') ? line.slice(0, -1) : line,
  )
}

/**
 * 经典 LCS 行级 diff。调用方负责保证 `before.length * after.length` 在预算内——这是个
 * O(n·m) 的表，没有预算它会在大文件上直接吃光内存。
 *
 * 表从右下往左上填，回溯时从左上往右下走，与 Rust 逐格对应（**方向不能反**：反过来在存在多条
 * 等长 LCS 时会选中另一条，输出的 diff 仍然正确但与桌面端不逐字相同）。
 */
export function diffLines(before: readonly string[], after: readonly string[]): DiffEdit[] {
  const columns = after.length + 1
  const table = new Uint32Array((before.length + 1) * columns)

  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      table[row * columns + column] =
        before[row] === after[column]
          ? table[(row + 1) * columns + column + 1] + 1
          : Math.max(table[(row + 1) * columns + column], table[row * columns + column + 1])
    }
  }

  const edits: DiffEdit[] = []
  let row = 0
  let column = 0
  while (row < before.length && column < after.length) {
    if (before[row] === after[column]) {
      edits.push({ tag: 'keep', line: before[row] })
      row += 1
      column += 1
    } else if (table[(row + 1) * columns + column] >= table[row * columns + column + 1]) {
      // 平手时先删后加——Rust 的 `>=` 就是这个取舍，改成 `>` 会让每个替换块的加删顺序对调。
      edits.push({ tag: 'remove', line: before[row] })
      row += 1
    } else {
      edits.push({ tag: 'add', line: after[column] })
      column += 1
    }
  }
  for (let index = row; index < before.length; index += 1) {
    edits.push({ tag: 'remove', line: before[index] })
  }
  for (let index = column; index < after.length; index += 1) {
    edits.push({ tag: 'add', line: after[index] })
  }
  return edits
}
