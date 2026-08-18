// 已裁剪区间上的最小编辑序列（经典 LCS）
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_common.rs 的 `diff_lines` 与 `DiffTag`。
//
// 单独成文件，是因为它与「一次写改了什么」是两件事：这里只回答「两个字符串数组之间最短的
// 增删序列是什么」，不认行、不认文件、不认预算。预算判定（表大小是否吃得消）留在调用方——
// 它超预算时的降级形态（整块替换 + `approximate`）属于摘要的语义，不属于 diff 算法。
//
// 表是 `rows × columns` 的一维数组（`Uint32Array`），与 Rust 的 `vec![0u32; rows * columns]`
// 逐格对应。调用方保证 `before.length * after.length` 不超过预算，所以这里不再自保。

/** 一条编辑。`keep` 也在序列里——渲染 diff 时它是上下文行（前缀空格）。 */
export interface DiffEdit {
  tag: 'keep' | 'add' | 'remove'
  line: string
}

/** 三种编辑在统一 diff 里的前缀字符。 */
export function diffMarker(tag: DiffEdit['tag']): string {
  if (tag === 'add') return '+'
  if (tag === 'remove') return '-'
  return ' '
}

/**
 * 在两段行数组之间求编辑序列。
 *
 * 回溯方向与 Rust 逐字一致：表从右下往左上填，回溯从左上往右下走，相等时 `keep`，否则
 * **优先 remove**（`table[row+1][column] >= table[row][column+1]` 取等号时走删除）。
 * 这个取等方向决定了「同一处改动是先删后增还是先增后删」，两边不一致的话 diff 文本会不同——
 * 而 diff 文本是要给模型看的，且 W16 会逐字节对拍。
 */
export function diffLines(before: readonly string[], after: readonly string[]): DiffEdit[] {
  const rows = before.length + 1
  const columns = after.length + 1
  const table = new Uint32Array(rows * columns)
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
