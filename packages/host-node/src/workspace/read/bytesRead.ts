// `read_workspace_file` 的字节分段读取：offset/maxBytes 分页 + 整文件 contentHash
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_read_bytes.rs（已随 T1 删除）的
// `read_workspace_file_blocking_with_access_at`。
//
// 【分页的四个字段怎么咬合】
//   · `offset` —— 本段从哪个字节开始，恒回显。`offset > totalBytes` 是错误（不是空段）；
//     `offset == totalBytes` 合法，给一段空内容且 `truncated: false`，这是「读到尾了」的终态。
//   · `bytes` —— 本段 `content` 的 UTF-8 字节数。它是**解码后**的长度，不是切出来的原始长度：
//     被 maxBytes 切在多字节字符中间时，残缺的尾巴被丢掉，`bytes` 因此小于 maxBytes，
//     而下一段正好从那个字符的开头开始 —— 分页无损靠的就是这一步。
//   · `nextOffset` —— `offset + bytes`，**只在还有后续字节时出现**；读到文件尾就不给。
//     调用方据「有没有这个键」判断要不要续读，不必自己比大小。
//   · `truncated` —— 同一个判据（`offset + bytes < totalBytes`）。注意它不等于「被 maxBytes
//     截断了」：一次把剩余内容读完的续读，即使触到了上限，只要没有剩余字节就是 false。
//
// 【contentHash 的三条语义】（判据核心，逐条对齐 Rust）
//   1. 只在 offset 0 的首片返回——续读的分片不带。它描述整个文件，只在「我正要开始读这个
//      文件」时有意义，每段重算一遍纯属浪费。
//   2. 截断时也返回。它是**整文件**的哈希、不是这一片的：乐观锁要守护的是「我读的时候文件
//      是这个样子」，而大文件恰恰最该防并发修改。早先只在「一次读完」时才给，于是任何超过
//      maxBytes 的文件永远拿不到 contentHash、只能裸覆盖。
//   3. 8 MB 以上不返回——超出 write_file 能整体替换的量级，给了也没有工具用得上，不值得为
//      此把整个文件扫一遍。
// 因此首段读取会把整个文件（最多 8 MB + 1 字节）读进来算哈希，即使 maxBytes 只有 20 KB。
// 刻意不分两次读（一次取内容、一次算哈希）：那样 content 与 contentHash 可能对应到不同的
// 文件版本，guard 过了而模型看到的并不是那一版。`+1` 是竞态兜底——stat 之后文件可能变大，
// 多读一个字节就能看出「已经超了 8 MB」，此时不给哈希。
//
// 【与 Rust 的两处形态差异，语义等价】
//   · Rust 先 `seek` 再顺序读，失败时报 "failed to seek …"。Node 用带 position 的定位读，
//     没有独立的 seek 步骤，那条错误消息因此没有对应物（其余消息逐字保留英文原文）。
//   · Rust 的 `take(n).read_to_end` 是增量扩容；Node 按 64 KiB 分块读再拼，避免为一次 20 KB
//     的请求先分配 8 MB 缓冲区。上限判定（读满 n 就停、EOF 就停）与 Rust 一致。
//
// 【给 W2】行定位模式（startLine / lineCount）是另一条实现路径，落在同域的 lines 文件里；
// `read_workspace_file` 这条命令要在两者之间分派（Rust 侧是 workspace_read.rs 的
// `read_workspace_file_blocking_at_lines`：两个 start_line / line_count 都没给才走字节模式，
// 且 startLine 与非零 offset 同时出现要报错）。分派与 registrar 都不在本卡里。

import type { Stats } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
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
  MAX_TRACE_READ_BYTES,
  normalizePositive,
} from './limits'
import type { ReadWorkspaceFileResult } from './types'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostCommandHandler } from '../../routeTable'

/** 一次 `read(2)` 的块大小。只影响内存占用，不影响结果。 */
const READ_CHUNK_BYTES = 64 * 1024

/** 放宽读取上限的归档轨迹目录（按**路径分量**比，`tracesX/` 不算）。 */
const TRACE_DIR_SEGMENTS = ['.webAgent-archive', 'traces']
const TRACE_FILE_SUFFIX = '.trace.jsonl'

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * 非负整数才算「调用方传了值」，其余（负数、小数、非有限、非数字）一律当作没传。
 *
 * **判存在只看值，不用 `'key' in args`**：走 HTTP 时 `JSON.stringify` 会丢掉值为 undefined
 * 的键，同一份入参在两种传输下键集合不同。收窄本身没有 Rust 对应物——那边这些非法值在
 * Tauri 的 deserialize 阶段就被挡掉了（`Option<u64>` / `Option<usize>`），Node 侧没有那道关卡。
 * 回落到默认值而不是整体拒绝，同 workspace/rg 的 normalizeRgInput。
 */
function nonNegativeIntegerArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * 该文件适用的单次读取上限。等价 Rust 里对 `relative_file_path` 的那两个判定：
 * 位于 `.webAgent-archive/traces/` 之下**且**文件名以 `.trace.jsonl` 结尾才放宽。
 *
 * 入参是 `relativeToRoot` 的结果，与 Rust 的 `strip_prefix(root).unwrap_or(path)` 同款：
 * 根外文件拿到的是绝对路径，首个分量是空串（`/` 开头），因此自然不匹配。
 */
function readCeilingFor(relativePath: string): number {
  const segments = relativePath.split('/')
  const inTraceDir = segments[0] === TRACE_DIR_SEGMENTS[0] && segments[1] === TRACE_DIR_SEGMENTS[1]
  const fileName = segments[segments.length - 1] ?? ''
  return inTraceDir && fileName.endsWith(TRACE_FILE_SUFFIX) ? MAX_TRACE_READ_BYTES : MAX_READ_BYTES
}

/** 从 `position` 起最多读 `limit` 字节（读到 EOF 就停）。等价 Rust 的 `take(limit).read_to_end`。 */
async function readAtMost(
  handle: FileHandle,
  position: number,
  limit: number,
  displayPath: string,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  while (total < limit) {
    const size = Math.min(READ_CHUNK_BYTES, limit - total)
    const buffer = Buffer.allocUnsafe(size)
    let bytesRead: number
    try {
      ;({ bytesRead } = await handle.read(buffer, 0, size, position + total))
    } catch (error) {
      throw new Error(`failed to read \`${displayPath}\`: ${errorText(error)}`)
    }
    if (bytesRead === 0) break
    chunks.push(bytesRead === size ? buffer : buffer.subarray(0, bytesRead))
    total += bytesRead
  }
  return chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, total)
}

async function statForRead(absolutePath: string, displayPath: string): Promise<Stats> {
  try {
    return await stat(absolutePath)
  } catch (error) {
    throw new Error(`file \`${displayPath}\` is not accessible: ${errorText(error)}`)
  }
}

async function openForRead(absolutePath: string, displayPath: string): Promise<FileHandle> {
  try {
    return await open(absolutePath, 'r')
  } catch (error) {
    throw new Error(`failed to open \`${displayPath}\`: ${errorText(error)}`)
  }
}

/**
 * 按字节偏移读一段文件。入参是 snake_case（core 的 `toTauriReadInput` 已经转好），
 * 但**未经校验**，收窄在本函数内完成。
 */
export async function readWorkspaceFileBytes(
  args: Record<string, unknown>,
): Promise<ReadWorkspaceFileResult> {
  const root = await resolveWorkspaceRoot(stringArg(args, 'workspace_root'))
  const requested = (stringArg(args, 'path') ?? '').trim()
  if (!requested) throw new Error('path (non-empty string) is required')

  const { absolutePath } = await resolveExistingWorkspacePath(root, requested, {
    allowExternalPaths: args.allow_external_paths === true,
  })
  // 错误消息里用绝对路径（Rust 的 `display_path`），返回值里用根相对路径（`relative_path`）。
  const displayPath = toSlashPath(absolutePath)

  const stats = await statForRead(absolutePath, displayPath)
  if (!stats.isFile()) throw new Error(`path \`${displayPath}\` is not a file`)
  const totalBytes = stats.size

  const offset = nonNegativeIntegerArg(args, 'offset') ?? 0
  if (offset > totalBytes) {
    throw new Error(`offset ${offset} exceeds file size ${totalBytes} for \`${displayPath}\``)
  }

  const relativePath = relativeToRoot(root, absolutePath)
  const maxBytes = normalizePositive(
    nonNegativeIntegerArg(args, 'max_bytes'),
    DEFAULT_READ_MAX_BYTES,
    readCeilingFor(relativePath),
  )
  const hashWholeFile = offset === 0 && totalBytes <= MAX_HASH_BYTES

  const handle = await openForRead(absolutePath, displayPath)
  let raw: Buffer
  try {
    raw = await readAtMost(
      handle,
      offset,
      hashWholeFile ? MAX_HASH_BYTES + 1 : maxBytes + 1,
      displayPath,
    )
  } finally {
    // 关闭失败无处可报，也不该盖掉正在抛的那个错误——等价 Rust 里 File 出作用域时的 drop。
    await handle.close().catch(() => {})
  }

  const contentHash = hashWholeFile && raw.length <= MAX_HASH_BYTES ? contentSha256(raw) : undefined
  const bufferTruncated = raw.length > maxBytes
  const slice = bufferTruncated ? raw.subarray(0, maxBytes) : raw
  rejectBinaryBytes(slice, displayPath)
  const content = decodeUtf8(slice, bufferTruncated, displayPath)

  const bytes = Buffer.byteLength(content, 'utf8')
  const nextPosition = offset + bytes
  const truncated = nextPosition < totalBytes

  const result: ReadWorkspaceFileResult = {
    path: relativePath,
    content,
    truncated,
    bytes,
    offset,
    totalBytes,
  }
  if (truncated) result.nextOffset = nextPosition
  if (contentHash !== undefined) result.contentHash = contentHash
  return result
}

/** 字节模式的 handler 工厂。`read_workspace_file` 的分派与注册见文件头「给 W2」。 */
export function createReadWorkspaceFileBytesHandler(
  _options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => readWorkspaceFileBytes(args)
}
