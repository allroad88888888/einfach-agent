// 一次改动到底改了什么：行数增减 + 截断过的 unified diff
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_common.rs（已随 T1 删除）的 `FileChangeSummary` / `compute_change_summary`。
// 目的是让模型**不必为了确认改动而把文件再读一遍**。Rust 侧这个函数被 `write_file` 与
// `apply_patch` 共用（`workspace_patch_pipeline.rs:93` 调它），Node 侧同样被 write 与 patch
// 两域共用。
//
// 【这份文件为什么曾经有两份】
// W7（write 流水线）与 W13（patch 流水线）并行施工时各自都需要它，但谁也不敢在
// `workspace/common/` 建同名文件——并行时后落笔的会静默盖掉先落笔的。于是两边各自落在自己的
// 域里（`workspace/write/changeSummary.ts` + `changeSummaryDiff.ts`、`workspace/patch/changeSummary.ts`
// + `lineDiff.ts`），约定等两卡都提交后由主会话逐条对照、合并回这里。
//
// 对照结果：算法、常量、渲染格式、返回形状、LCS 回溯取等号的方向全部一致；唯一的实质分歧在
// `splitLines`（见 lineDiff.ts 的说明），与本文件无关。
//
// 【两处容易和 Rust 对不上的地方（splitLines 的坑单独记在 lineDiff.ts）】
//  1. **头尾裁剪之后才算 diff**：未改动的头尾不进 diff，`@@` 头里的起始行号是裁掉的头部长度 +1。
//  2. **超预算不是失败而是降级**：LCS 表大于 `DIFF_LCS_BUDGET` 时不假装算得出最小 diff，
//     整段按「全删 + 全增」上报并把 `approximate` 置真——计数因此是上界，不是精确值。
//
// 【口径】统计的是**行**不是字符；行的定义见 lineDiff.ts 的 `splitLines`（= Rust `str::lines()`）。

import { diffLines, diffMarker, splitLines, type DiffEdit } from './lineDiff'

/** 回给模型的 diff 行数上限。够确认改动落没落，又不至于把工具结果撑爆。 */
const DIFF_MAX_LINES = 60
/** LCS 表的预算（before 行数 × after 行数）。超了就退化成「整块替换」并标记 `approximate`。 */
const DIFF_LCS_BUDGET = 800 * 800

/**
 * 一次改动实际改了什么。字段名与 Rust 的 `#[serde(rename_all = "camelCase")]` 一致，也与
 * core 的 `normalizeWriteChangeSummary` 认的键一致；尽管包着它的 write / patch 各自的结果
 * 结构里，write 是 snake_case、patch 是 camelCase（见各自 `result.ts`），同一份 JSON 里两种
 * 命名并存，照搬不做统一。
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
  /** 变动区间的统一 diff。无变动时**键不存在**（Rust 的 `skip_serializing_if`）。 */
  diff?: string
  diffTruncated: boolean
  /** 变动区间大到算不起最小 diff，计数按整块替换给出，是上界。 */
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
 *
 * 「无变动」是单独的早退（见下方 return 处的注释），dry run 的 `would_change` 正是据此判定的。
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
