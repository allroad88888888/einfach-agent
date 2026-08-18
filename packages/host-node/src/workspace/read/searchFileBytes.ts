// `search_workspace_files` 的单文件有界读取：从头读到 limit+1 字节，供调用方判定是否截断
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_read_search.rs 的 `File::open` + `take(limit+1).read_to_end`
// 那两步。开与读的失败各有各的错误文案（"failed to open" / "failed to read"），因此拆成 open +
// 手动分块读，而不是用 `createReadStream` 一把梭——stream 把两种失败都压成同一个 'error' 事件，
// 分不出是哪一步坏的。
//
// **不复用 bytesRead.ts 的 `readAtMost`**：那是私有函数且不对外导出，W1 的文件本卡不碰；
// 这里的读取起点固定是 0（`maybe_search_file` 从不做偏移读），逻辑比 W1 那份更简单，独立一份
// 不算重复造轮子。

import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { errorText } from '../common'

const READ_CHUNK_BYTES = 64 * 1024

async function openForSearch(absolutePath: string, displayPath: string): Promise<FileHandle> {
  try {
    return await open(absolutePath, 'r')
  } catch (error) {
    throw new Error(`failed to open \`${displayPath}\`: ${errorText(error)}`)
  }
}

async function readFromStart(
  handle: FileHandle,
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
      ;({ bytesRead } = await handle.read(buffer, 0, size, total))
    } catch (error) {
      throw new Error(`failed to read \`${displayPath}\`: ${errorText(error)}`)
    }
    if (bytesRead === 0) break
    chunks.push(bytesRead === size ? buffer : buffer.subarray(0, bytesRead))
    total += bytesRead
  }
  return chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, total)
}

/**
 * 从文件开头最多读 `limit + 1` 字节。等价 Rust 的 `take((limit + 1) as u64).read_to_end`：
 * 多读的那 1 字节只用来判定「是否超出 limit」，不代表真的允许调用方使用这一字节。
 *
 * open/read 失败都**向上抛**，不在这里吞掉——等价 Rust 用 `?` 传播，一个文件打不开/读不动会
 * 让整条 `search_workspace_files` 命令报错，不是跳过这个文件继续搜别的。这与「二进制/非 UTF-8
 * 内容」的软跳过是两回事，后者在调用方（searchFiles.ts 的 `maybeSearchFile`）处理。
 */
export async function readUpToLimitPlusOne(
  absolutePath: string,
  displayPath: string,
  limit: number,
): Promise<Buffer> {
  const handle = await openForSearch(absolutePath, displayPath)
  try {
    return await readFromStart(handle, limit + 1, displayPath)
  } finally {
    await handle.close().catch(() => {})
  }
}
