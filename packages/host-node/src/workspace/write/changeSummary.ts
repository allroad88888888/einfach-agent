// 一次写入到底改了什么：行级增删计数 + 变动区间的统一 diff
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_common.rs 的 `compute_change_summary` / `FileChangeSummary`
// 与那两个常量。存在的理由是「调用方不必为了确认一次编辑落没落，再读一遍文件」。
//
// 【它暂时住在 write 域，而 Rust 侧住在 common】
// Rust 的 `compute_change_summary` 被 write 与 patch **两个**域用（`workspace_patch_pipeline.rs:93`）。
// Node 侧本该同样住 `workspace/common/`，但 W13（patch 流水线）正与本卡并行施工，同一个新文件
// 两个 agent 各写各的，后落笔的会静默盖掉先落笔的。**等 W13 落地后由主会话把这两份合并进
// `workspace/common/`**——那时两边的实现要逐字对照，别默认哪一份是对的。
//
// 【三处 JS 直觉会写错的地方】
//  1. **`str::lines()` 不是 `split('\n')`**：`"a\nb\n"` 是 2 行不是 3 行，空串是 **0 行**不是 1 行，
//     `\r\n` 的 `\r` 要剥掉——但只在它确实是行结束符时剥，末行没有换行符时结尾的 `\r`
//     属于内容（Rust 的 `lines()` 先 `strip_suffix('\n')`，失败就整段原样返回）。
//  2. **头尾裁剪之后才算 diff**：未改动的头尾不进 diff，`@@` 头里的起始行号是裁掉的头部长度 +1。
//  3. **超预算不是失败而是降级**：LCS 表大于 `DIFF_LCS_BUDGET` 时不假装算得出最小 diff，
//     整段按「全删 + 全增」上报并把 `approximate` 置真——计数因此是上界，不是精确值。

import { diffLines, diffMarker } from './changeSummaryDiff'

/** 统一 diff 最多带多少条编辑行。够确认改动落了，又不至于淹没工具结果。 */
const DIFF_MAX_LINES = 60
/** LCS 表的规模预算（改前行数 × 改后行数）。超过它就降级成整块替换。 */
const DIFF_LCS_BUDGET = 800 * 800

/**
 * 一次写入的行级摘要。**键是 camelCase**——Rust 侧 `FileChangeSummary` 带
 * `rename_all = "camelCase"`，尽管包着它的 `WorkspaceWriteResult` 是 snake_case（见 result.ts）。
 * 同一份 JSON 里两种命名并存，照搬。
 */
export interface FileChangeSummary {
  linesAdded: number
  linesRemoved: number
  beforeLines: number
  afterLines: number
  /** 变动区间的统一 diff。无变动时**键不存在**（Rust 的 `skip_serializing_if`）。 */
  diff?: string
  diffTruncated: boolean
  /** 变动区间大到算不起最小 diff，计数按整块替换给出，是上界。 */
  approximate: boolean
}

/**
 * 算一次写入的行级摘要。`before` 为 `null` 表示这个文件原本不存在（新建）。
 *
 * 注意「无变动」这条早退：头尾裁剪之后两边都空，就是内容完全相同——返回的计数全 0 且
 * **没有 diff 键**，而不是一个空 diff。dry run 的 `would_change` 正是据此判定的。
 */
export function computeChangeSummary(before: string | null, after: string): FileChangeSummary {
  const beforeLines = before === null ? [] : splitLines(before)
  const afterLines = splitLines(after)

  let head = 0
  while (
    head < beforeLines.length &&
    head < afterLines.length &&
    beforeLines[head] === afterLines[head]
  ) {
    head += 1
  }
  let tail = 0
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1
  }

  const beforeMid = beforeLines.slice(head, beforeLines.length - tail)
  const afterMid = afterLines.slice(head, afterLines.length - tail)
  if (beforeMid.length === 0 && afterMid.length === 0) {
    return {
      linesAdded: 0,
      linesRemoved: 0,
      beforeLines: beforeLines.length,
      afterLines: afterLines.length,
      diffTruncated: false,
      approximate: false,
    }
  }

  const affordable = beforeMid.length * afterMid.length <= DIFF_LCS_BUDGET
  const edits = affordable
    ? diffLines(beforeMid, afterMid)
    : [
        ...beforeMid.map((line) => ({ tag: 'remove' as const, line })),
        ...afterMid.map((line) => ({ tag: 'add' as const, line })),
      ]

  const diffTruncated = edits.length > DIFF_MAX_LINES
  const rendered = [`@@ -${head + 1},${beforeMid.length} +${head + 1},${afterMid.length} @@`]
  for (const edit of edits.slice(0, DIFF_MAX_LINES)) {
    rendered.push(`${diffMarker(edit.tag)}${edit.line}`)
  }
  if (diffTruncated) {
    rendered.push(`... ${edits.length - DIFF_MAX_LINES} more diff lines`)
  }

  return {
    linesAdded: edits.filter((edit) => edit.tag === 'add').length,
    linesRemoved: edits.filter((edit) => edit.tag === 'remove').length,
    beforeLines: beforeLines.length,
    afterLines: afterLines.length,
    diff: rendered.join('\n'),
    diffTruncated,
    approximate: !affordable,
  }
}

/**
 * 等价 Rust 的 `str::lines()`。
 *
 * 空串给空数组（`''.split('\n')` 给 `['']`，直接用会把空文件算成 1 行）；末尾的换行符不额外
 * 产生一行；`\r\n` 的 `\r` 只在它确实位于换行符之前时才剥掉——`"a\r"` 是一行 `"a\r"`，
 * 不是 `"a"`。这三条各有一条测试钉着。
 */
function splitLines(value: string): string[] {
  if (value.length === 0) return []
  const segments = value.split('\n')
  const endsWithNewline = segments[segments.length - 1] === ''
  if (endsWithNewline) segments.pop()
  const last = segments.length - 1
  return segments.map((line, index) =>
    (endsWithNewline || index < last) && line.endsWith('\r') ? line.slice(0, -1) : line,
  )
}
