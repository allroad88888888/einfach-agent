// 行切分（Rust `str::lines()` 等价物）与 LCS 行级 diff
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
//
// 单独成文件，是因为它与「一次写改了什么」是两件事：这里只回答「两个字符串数组之间最短的
// 增删序列是什么」，不认行、不认文件、不认预算。预算判定（表大小是否吃得消）留在调用方——
// 它超预算时的降级形态（整块替换 + `approximate`）属于摘要的语义，不属于 diff 算法。
//
// 表是 `rows × columns` 的一维数组（`Uint32Array`），与 Rust 的 `vec![0u32; rows * columns]`
// 逐格对应。调用方保证 `before.length * after.length` 不超过预算，所以这里不再自保。
//
// 【这份文件为什么曾经在 workspace/write 与 workspace/patch 各有一份】
// Rust 侧 `compute_change_summary` / `diff_lines` 住在 `workspace_common.rs`，被 `write_file` 与
// `apply_patch` 共用（`workspace_patch_pipeline.rs:93` 调它）。Node 侧 W7（write 流水线）与 W13
// （patch 流水线）并行施工时都需要它，但谁也不敢在 `workspace/common/` 建同名文件——并行时
// 后落笔的会静默盖掉先落笔的，于是各自落在自己的域里（`workspace/write/changeSummaryDiff.ts`、
// `workspace/patch/lineDiff.ts`）。两卡都提交后，主会话逐条对照两份实现并合并到这里：算法、
// 常量、渲染格式、返回形状、LCS 回溯取等号的方向全部一致；唯一的实质分歧是 `splitLines` 对
// **末行无换行符时结尾 `\r`** 的处理——patch 域那份一度无条件剥掉，已按 Rust（与 write 域那份
// 一致）改正为「只剥真正位于换行符之前的 `\r`」，两卡提交时这条已经一致。公开面取了并集：
// `splitLines` 与 `DiffTag` 都对外导出（patch 版本的做法，write 版本里 `splitLines` 是私有的）——
// 末行 `\r` 这条边界值得被直接单测，不必每次都绕经 `computeChangeSummary`。

/** 一条编辑的类型。marker 就是它在 unified diff 里的行首字符。 */
export type DiffTag = 'keep' | 'add' | 'remove'

/** 一条编辑。`keep` 也在序列里——渲染 diff 时它是上下文行（前缀空格）。 */
export interface DiffEdit {
  tag: DiffTag
  line: string
}

/** 行首标记，与 Rust `DiffTag::marker()` 一一对应；也是它在统一 diff 里的前缀字符。 */
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
 * 等长 LCS 时会选中另一条，输出的 diff 仍然正确但与桌面端不逐字相同）。回溯相等时 `keep`，
 * 否则**优先 remove**（`table[row+1][column] >= table[row][column+1]` 取等号时走删除）。这个
 * 取等方向决定了「同一处改动是先删后增还是先增后删」，两边不一致的话 diff 文本会不同——而
 * diff 文本是要给模型看的，且 W16 会逐字节对拍。
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
