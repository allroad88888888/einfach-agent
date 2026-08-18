// 一次改动到底改了什么：行数增减 + 截断过的 unified diff
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_common.rs 的 `FileChangeSummary` / `compute_change_summary`。
// 目的是让模型**不必为了确认改动而把文件再读一遍**。
//
// 【为什么这份实现暂时住在 patch 域里】
// Rust 侧它在 `workspace_common.rs`，被 `write_file` 与 `apply_patch` 共用；Node 侧 `workspace/common/`
// 眼下还没有它，而 write 域（W7）与本卡是同一批并行开工的。两张卡各自在 common 里新建同名文件
// 会互相覆盖，所以两边各落在自己的域内、**都不去动共用目录**。
//
// **同一批里 W7 确实也落了一份**：`workspace/write/changeSummary.ts` + `changeSummaryDiff.ts`。
// 两份已逐段对照过，算法、常量、渲染与返回形状完全一致（连 LCS 回溯取等号的方向都同款）；
// 唯一一处曾经的分歧是 `splitLines` 对**末行无换行符时结尾 `\r`** 的处理，本份当时剥了、
// Rust 与 W7 那份不剥——已按 Rust 改正并补了回归测试（lineDiff.test.ts）。
// 主会话合并两份进 `workspace/common/` 时，删掉的是本文件与 lineDiff.ts，接口面不变。
//
// 【口径】统计的是**行**不是字符；行的定义见 lineDiff.ts 的 `splitLines`（= Rust `str::lines()`）。

import { diffLines, diffMarker, splitLines, type DiffEdit } from './lineDiff'

/** 回给模型的 diff 行数上限。够确认改动落没落，又不至于把工具结果撑爆。 */
const DIFF_MAX_LINES = 60
/** LCS 表的预算（before 行数 × after 行数）。超了就退化成「整块替换」并标记 `approximate`。 */
const DIFF_LCS_BUDGET = 800 * 800

/**
 * 一次写入实际改了什么。字段名与 Rust 的 `#[serde(rename_all = "camelCase")]` 一致，也与
 * core 的 `normalizeWriteChangeSummary` 认的键一致。
 *
 * `diff` 用可选属性而不是 `string | null`：Rust 那边带 `skip_serializing_if = "Option::is_none"`，
 * 没有 diff 时**这个键根本不出现**。（W14 那条「可空字段一律写成 `T | null`」说的是没有
 * skip_serializing_if 的字段，两者不矛盾——判据始终是「Rust 序列化出来有没有这个键」。）
 */
export interface FileChangeSummary {
  linesAdded: number
  linesRemoved: number
  beforeLines: number
  afterLines: number
  diff?: string
  diffTruncated: boolean
  approximate: boolean
}

/**
 * 算出 `before → after` 的改动摘要。`before` 为 `null` = 这个文件是新建的（按 0 行处理）。
 *
 * 三步：
 *   1. **掐头去尾**——前后完全相同的行不进 diff。真实的编辑通常只动文件中间几行，不掐的话 LCS
 *      要在整个文件上跑，预算立刻就不够了。
 *   2. 中间那段过 LCS（**前提是表放得下**）；放不下就报成「整块删掉再整块加回来」，并把
 *      `approximate` 置真告诉模型这不是最小 diff。
 *   3. 渲染成 unified diff，超过 `DIFF_MAX_LINES` 截断并附上还剩多少行。
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

  // 掐完两头都空了 = 内容一个字没变。此时**没有 diff 键**，而不是给一个空 diff。
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
  const edits: DiffEdit[] = affordable
    ? diffLines(beforeMid, afterMid)
    : [
        ...beforeMid.map((line): DiffEdit => ({ tag: 'remove', line })),
        ...afterMid.map((line): DiffEdit => ({ tag: 'add', line })),
      ]

  const diffTruncated = edits.length > DIFF_MAX_LINES
  const rendered = [`@@ -${head + 1},${beforeMid.length} +${head + 1},${afterMid.length} @@`]
  for (const edit of edits.slice(0, DIFF_MAX_LINES)) {
    rendered.push(`${diffMarker(edit.tag)}${edit.line}`)
  }
  if (diffTruncated) rendered.push(`... ${edits.length - DIFF_MAX_LINES} more diff lines`)

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
