// `read_workspace_file` 的行定位读取：startLine / lineCount 返回**完整行**
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_read_lines.rs（已随 T1 删除）的 `read_workspace_file_lines`。
// 存在的理由（Rust 文件头原话）：模型手里的行号来自 rg_search / 编译错误 / diff，字节偏移接不上
// 它们；这条路径让「读第 342 行附近」成为一次直接调用，而不是整段读回来自己数行。
//
// 【行是怎么切的】Rust 用 `str::split_inclusive('\n')`，本文件用 `lineBoundaries` 复刻它。三条
// 边角决定 `totalLines` / `endLine`，而调用方拿这些数字接着请求下一段，错一行就漏读或重读：
//   · **末行没有换行符仍然算一行**。`"a\nb"` 是 2 行（`["a\n", "b"]`）。
//   · **空文件是 0 行**，不是 1 行。于是 `startLine: 1` 读空文件命中「startLine 1 exceeds the
//     file's 0 line(s)」而不是回一段空内容——JS 的 `''.split('\n')` 给 `['']`（1 段），照着写
//     就会与 Rust 分叉，所以这里不用 `split`。
//   · **`\r\n` 不额外成行**，`\r` 留在它所属行的内容里。行尾原样保留（`split_inclusive` 的语义），
//     因此拼回去与磁盘逐字节一致，读到的内容可以直接当 apply_patch 的 oldText 用；把 CRLF
//     规范化成 LF 会让这条用途整个失效。
//
// 【三个游标共用一个判据】`servedAll = endIndex >= totalLines`：
//   · `truncated` = `!servedAll`
//   · `nextLine` = `endIndex + 1`，只在 `!servedAll` 时**存在这个键**（不是 undefined、不是 0）
//   · `nextOffset` = `offset + bytes`，同一个条件
// 与字节模式的 `nextOffset` 同款：判的是「文件里还剩没剩」，不是「这次有没有触上限」。一次把
// 剩余内容读完的续读即使正好读满 maxBytes，也是 `truncated: false` 且不带 next*。
//
// 【contentHash：行模式只有一个条件】`startLine === 1` 就给，截断也给。字节模式的「8 MB 以上
// 不给」在这里没有对应分支——行模式**整文件读入**（定位第 N 行必须先看过它前面所有字节），
// 所以超过 MAX_HASH_BYTES 的文件在进入之前就被整体拒绝了，能走到算哈希这一步的必然 ≤ 8 MB。
//
// 【maxBytes 按整行截断】半行内容既不能用作 oldText，也无法让模型判断自己看到了什么。因此
// 上限是「加上这一行会超就停」，但**第一行无条件收下**——否则单行长于 maxBytes 的文件会返回
// 空内容且 nextLine 原地不动，续读变成死循环。
//
// 【上限用 MAX_READ_BYTES，不走 W1 的轨迹目录放宽】Rust 这里写死
// `normalize_positive(max_bytes, DEFAULT_READ_MAX_BYTES, MAX_READ_BYTES)`，没有
// `.webAgent-archive/traces/*.trace.jsonl` 的那条放宽（那是字节模式独有的）。照搬。

import type { Stats } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import {
  errorText,
  relativeToRoot,
  resolveExistingWorkspacePath,
  resolveWorkspaceRoot,
  toSlashPath,
} from '../common'
import { contentSha256 } from '../common/contentHash'
import { decodeUtf8, rejectBinaryBytes } from './content'
import {
  DEFAULT_READ_MAX_BYTES,
  MAX_HASH_BYTES,
  MAX_READ_BYTES,
  normalizePositive,
} from './limits'
import type { ReadWorkspaceFileResult } from './types'

/**
 * 行模式的入参。**已经收窄过**——和 Rust 的 `read_workspace_file_lines(path, max_bytes,
 * start_line, line_count, …)` 一样是具名参数而不是原始 args：原始载荷的收窄归命令层
 * （`linesDispatch.ts`，对应 Rust 的 `read_workspace_file` + `..._at_lines`）。
 */
export interface LineReadRequest {
  /** 未 trim 的请求路径。trim 与空值判定在本函数内，顺序对齐 Rust。 */
  path: string
  /** 未给（或非法）时回落 DEFAULT_READ_MAX_BYTES，钳到 MAX_READ_BYTES。 */
  maxBytes: number | undefined
  /** 1-based。`0` 会被本函数拒绝（Rust 的 `usize` 允许 0 进来，判定也在函数里）。 */
  startLine: number
  /** 未给 = 读到文件末尾。`0` 会被本函数拒绝。 */
  lineCount: number | undefined
  workspaceRoot: string | undefined
  allowExternalPaths: boolean
}

/**
 * 每一行的**结束**字符下标（不含），下标 i 的行覆盖 `[boundaries[i-1] ?? 0, boundaries[i])`。
 * 等价 `str::split_inclusive('\n')` 切出来的段数与段界。
 *
 * 返回的是下标数组而不是切好的字符串数组：文件最大 8 MB，切成几十万个子串只为数行数不划算，
 * 而真正要拼出来的只有被选中的那一段。
 */
function lineBoundaries(text: string): number[] {
  const boundaries: number[] = []
  let cursor = 0
  for (;;) {
    const index = text.indexOf('\n', cursor)
    if (index < 0) break
    cursor = index + 1
    boundaries.push(cursor)
  }
  // 末尾还有内容却没有换行符 —— 那是最后一行，`split_inclusive` 同样把它算作一段。
  if (cursor < text.length) boundaries.push(text.length)
  return boundaries
}

function lineStart(boundaries: number[], index: number): number {
  return index === 0 ? 0 : boundaries[index - 1]
}

/** 按行定位读一段文件。 */
export async function readWorkspaceFileLines(
  request: LineReadRequest,
): Promise<ReadWorkspaceFileResult> {
  // 这两条在解析 root / 路径之前，与 Rust 同序：入参本身矛盾时不该先去碰文件系统。
  if (request.startLine === 0) {
    throw new Error('startLine is 1-based; use 1 for the first line')
  }
  if (request.lineCount === 0) {
    throw new Error('lineCount must be greater than 0')
  }

  const root = await resolveWorkspaceRoot(request.workspaceRoot)
  const requested = request.path.trim()
  if (!requested) throw new Error('path (non-empty string) is required')

  const { absolutePath } = await resolveExistingWorkspacePath(root, requested, {
    allowExternalPaths: request.allowExternalPaths,
  })
  // 错误消息里用绝对路径（Rust 的 `display_path`），返回值里用根相对路径（`relative_path`）。
  // 这是 docs/node-host-issues.md 第 5 条记下的 Rust 侧问题，照搬不改。
  const displayPath = toSlashPath(absolutePath)

  let stats: Stats
  try {
    stats = await stat(absolutePath)
  } catch (error) {
    throw new Error(`file \`${displayPath}\` is not accessible: ${errorText(error)}`)
  }
  if (!stats.isFile()) throw new Error(`path \`${displayPath}\` is not a file`)
  const totalBytes = stats.size

  // 定位第 N 行必须先看过它前面的所有字节，所以行模式按整文件读入；再大的文件退回 offset 分段。
  if (totalBytes > MAX_HASH_BYTES) {
    throw new Error(
      `file \`${displayPath}\` is ${totalBytes} bytes, too large for line addressing; ` +
        'read it in byte chunks with offset/nextOffset instead',
    )
  }

  let raw: Buffer
  try {
    raw = await readFile(absolutePath)
  } catch (error) {
    throw new Error(`failed to read \`${displayPath}\`: ${errorText(error)}`)
  }
  rejectBinaryBytes(raw, displayPath)
  // 整文件读入，尾部不存在「被 maxBytes 切开的多字节序列」，所以不允许残缺尾巴。
  const text = decodeUtf8(raw, false, displayPath)
  // Rust 是 `content_sha256(text.as_bytes())`。严格解码成功意味着 text 重新编码就是 raw
  // 本身（BOM 也已由 decodeUtf8 的 ignoreBOM 保留），所以直接哈希 raw，省一次全文重编码。
  const contentHash = contentSha256(raw)

  const boundaries = lineBoundaries(text)
  const totalLines = boundaries.length
  if (request.startLine > totalLines) {
    throw new Error(
      `startLine ${request.startLine} exceeds the file's ${totalLines} line(s) in \`${displayPath}\``,
    )
  }

  const byteCeiling = normalizePositive(request.maxBytes, DEFAULT_READ_MAX_BYTES, MAX_READ_BYTES)
  const firstIndex = request.startLine - 1
  const requestedLast =
    request.lineCount === undefined
      ? totalLines
      : Math.min(firstIndex + request.lineCount, totalLines)

  const pieces: string[] = []
  let collectedBytes = 0
  let endIndex = firstIndex
  for (let index = firstIndex; index < requestedLast; index += 1) {
    const segment = text.slice(lineStart(boundaries, index), boundaries[index])
    const segmentBytes = Buffer.byteLength(segment, 'utf8')
    // 已经收下过内容、再加这一行就超上限 → 停。首行走不到这里，因此单行超限时仍会被整行返回。
    if (collectedBytes !== 0 && collectedBytes + segmentBytes > byteCeiling) break
    pieces.push(segment)
    collectedBytes += segmentBytes
    endIndex += 1
    if (collectedBytes >= byteCeiling) break
  }

  const byteOffset = Buffer.byteLength(text.slice(0, lineStart(boundaries, firstIndex)), 'utf8')
  const servedAll = endIndex >= totalLines

  const result: ReadWorkspaceFileResult = {
    path: relativeToRoot(root, absolutePath),
    content: pieces.join(''),
    truncated: !servedAll,
    bytes: collectedBytes,
    offset: byteOffset,
    totalBytes,
    startLine: request.startLine,
    endLine: endIndex,
    totalLines,
  }
  if (!servedAll) {
    result.nextOffset = byteOffset + collectedBytes
    result.nextLine = endIndex + 1
  }
  // 起始行读取等价于从头读，此时哈希与字节模式的首段语义一致。
  if (request.startLine === 1) result.contentHash = contentHash
  return result
}
