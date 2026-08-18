// rg `--json` 输出的逐行解析：本域的主体逻辑
// ---------------------------------------------------------------------------
// 对齐 Rust 的 `parse_rg_stdout` 及其四个 `extract_*` helper。`--json` 每行一个事件，
// 解析了 `context` 与 `match` 两种类型，其余（`begin` / `end` / `summary`，以及任何解析不出
// JSON 的行）原样跳过——与 Rust `match value.get("type")... { _ => {} }` 及
// `let Ok(value) = ... else { continue }` 逐条一致。
//
// 上下文行的两段状态机（与 Rust 变量名一一对应）：
//   · `pendingBefore` —— 还没配上某条命中的「之前」缓冲，容量钳在 `contextLines`（超出时丢最旧
//     的一条，`Array.shift()` 对应 Rust 的 `Vec::remove(0)`）。
//   · `afterRemaining` —— 命中之后还要再吃几行 context 塞进它的 `after`；每条命中重置为
//     `contextLines`，命中之间被 context 事件耗尽为 0。
//
// 命中数到 `maxMatches` 时：标记 truncated、调用 `onTruncated()`（对齐 Rust 的
// `let _ = child.kill()`）、**不再读后续行**（`break`）——不是读完整个流再截断。

import { isAbsolute } from 'node:path'
import { isWithinRoot, toSlashPath } from '../common'
import type { RgSearchMatch } from './types'

export interface ParsedRgOutput {
  matches: RgSearchMatch[]
  truncated: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rgData(event: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(event.data) ? event.data : undefined
}

/** 等价 `normalize_display_path`：仅对绝对路径尝试转成根相对；其余只做反斜杠→斜杠。 */
function normalizeDisplayPath(path: string, root: string): string {
  if (isAbsolute(path) && isWithinRoot(root, path)) {
    const remainder = path.slice(root.length).replace(/^[\\/]+/, '')
    return toSlashPath(remainder)
  }
  return toSlashPath(path)
}

function extractPath(event: Record<string, unknown>, root: string): string {
  const data = rgData(event)
  const pathField = data?.path
  const text = isRecord(pathField) && typeof pathField.text === 'string' ? pathField.text : ''
  return normalizeDisplayPath(text, root)
}

function extractLineNumber(event: Record<string, unknown>): number {
  const value = rgData(event)?.line_number
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function extractColumn(event: Record<string, unknown>): number {
  const submatches = rgData(event)?.submatches
  const first = Array.isArray(submatches) && isRecord(submatches[0]) ? submatches[0] : undefined
  const start = first?.start
  return typeof start === 'number' && Number.isFinite(start) && start >= 0 ? start + 1 : 1
}

function extractLine(event: Record<string, unknown>): string {
  const lines = rgData(event)?.lines
  const text = isRecord(lines) && typeof lines.text === 'string' ? lines.text : ''
  return text.replace(/[\r\n]+$/, '')
}

export async function parseRgStdout(
  lines: AsyncIterable<string>,
  root: string,
  contextLines: number,
  maxMatches: number,
  onTruncated: () => void,
): Promise<ParsedRgOutput> {
  const matches: RgSearchMatch[] = []
  let truncated = false
  let pendingBefore: string[] = []
  let afterRemaining = 0

  for await (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue

    const type = parsed.type
    if (type === 'context') {
      const contextLine = extractLine(parsed)
      if (afterRemaining > 0) {
        matches[matches.length - 1]?.after.push(contextLine)
        afterRemaining -= 1
      } else if (contextLines > 0) {
        pendingBefore.push(contextLine)
        if (pendingBefore.length > contextLines) pendingBefore.shift()
      }
      continue
    }

    if (type === 'match') {
      if (matches.length >= maxMatches) {
        truncated = true
        onTruncated()
        break
      }
      matches.push({
        path: extractPath(parsed, root),
        lineNumber: extractLineNumber(parsed),
        column: extractColumn(parsed),
        line: extractLine(parsed),
        before: pendingBefore,
        after: [],
      })
      pendingBefore = []
      afterRemaining = contextLines
    }
  }

  return { matches, truncated }
}
