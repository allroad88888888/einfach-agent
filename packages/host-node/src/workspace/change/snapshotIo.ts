// 文件快照与磁盘之间的两个方向
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_snapshot.rs（已随 T1 删除）的 `read_snapshot` /
// `write_snapshot`。纯逻辑那半（由内容构造快照、判两个快照是不是同一个状态）在 W14 的
// fileSnapshot.ts，这里只负责碰盘的那半。
//
// ═══ 写回时 `content: null` 的含义是**删除** ═══
// 不是「写一个空文件」（那是 `content: ''`）。差一个字符，后果是删除与清空之别。
//
// ⚠️ **照搬下来的一处危险语义**（W14 在 parseChangeSet.ts 标过，docs/node-host-issues.md 第 3 条）：
// 条目里 `content` 键缺失会被 serde 当成 `null`，于是一份**被截断的条目**不会解析失败，而是
// 让回滚把用户的文件删掉。所以本文件看到的 `content === null` 有两种来源——「那一刻文件真的
// 不存在」与「条目坏了」——而在这一层**分辨不出来**。要修得两个宿主一起加 `exists ===
// (content !== null)` 的自洽校验（Node 单方面收严会拒掉桌面端写的合法条目），不在本卡。
//
// ═══ 读回时为什么二进制/非 UTF-8 直接拒 ═══
// 整文件改写的账把改前内容以字符串存进 JSON，本来就只覆盖文本文件。回滚时读到二进制说明现场
// 已经不是当初那个文件了，此时「尽力解码」只会拿一个坏掉的字符串去和 hash 比对，得出「内容变了」
// 这个**碰巧正确但理由错误**的结论。明确拒绝，让调用方看见真正的原因。
//
// 解码用 `TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`：
//   · `fatal` —— 等价 Rust 的 `String::from_utf8`（校验失败返回 Err），不是 lossy 替换。
//   · `ignoreBOM: true` —— **反直觉但必须**：这个选项的含义是「不要把 BOM 当标记吃掉」。默认
//     值 `false` 会**剥掉** BOM，于是带 BOM 的文件解出来少三个字节，hash 与 Rust 算的对不上，
//     回滚被判成「文件变了」。名字读起来像是反的，实际语义以 WHATWG Encoding 规范为准。
//
// 写回**刻意不走 common 的 `atomicWrite`**（与 entryStore.ts 的选择相反）：那是在写用户的
// workspace 文件，原子替换会换掉 inode 并重设权限位，而 Rust 侧这里就是一次朴素的 `fs::write`。
// 日志条目那边是宿主自己的文件、掉电即失去唯一凭据，两处的取舍不同是有理由的，不是不一致。

import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { errorText } from '../common/errorText'
import { isWithinRoot } from '../common/pathContainment'
import { fileSnapshotFromContent } from './fileSnapshot'
import { pathExists } from './pathProbe'
import type { FileSnapshot } from './types'

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** 把磁盘上的当前状态读成快照。文件不存在 → `content: null` 的快照，不是错误。 */
export async function readSnapshot(path: string): Promise<FileSnapshot> {
  if (!(await pathExists(path))) return fileSnapshotFromContent(null)
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new Error(`failed to read \`${path}\`: ${errorText(error)}`)
  }
  if (bytes.includes(0)) {
    throw new Error(`binary file is not reversible: \`${path}\``)
  }
  let content: string
  try {
    content = UTF8.decode(bytes)
  } catch {
    throw new Error(`non-UTF-8 file is not reversible: \`${path}\``)
  }
  return fileSnapshotFromContent(content)
}

/** 把快照写回磁盘：有内容就写，没内容就删。两条路径都先确认没跑出 workspace root。 */
export async function writeSnapshot(
  root: string,
  path: string,
  snapshot: FileSnapshot,
): Promise<void> {
  if (!isWithinRoot(root, path)) {
    throw new Error('recorded path escaped workspace root')
  }
  if (snapshot.content === null) {
    if (await pathExists(path)) {
      try {
        await unlink(path)
      } catch (error) {
        throw new Error(`failed to remove \`${path}\`: ${errorText(error)}`)
      }
    }
    return
  }
  // 父目录**建出来之后再 canonicalize 一次**：路径本身可能落在一条指向 workspace 外的软链
  // 下面，而那条软链在词法比对里看不出来。顺序不能颠倒——目录不存在时 realpath 无从下手。
  const parent = dirname(path)
  try {
    await mkdir(parent, { recursive: true })
  } catch (error) {
    throw new Error(`failed to create \`${parent}\`: ${errorText(error)}`)
  }
  let canonicalParent: string
  try {
    canonicalParent = await realpath(parent)
  } catch (error) {
    throw new Error(`failed to resolve \`${parent}\`: ${errorText(error)}`)
  }
  if (!isWithinRoot(root, canonicalParent)) {
    throw new Error('recorded path escaped workspace root')
  }
  try {
    await writeFile(path, snapshot.content, 'utf8')
  } catch (error) {
    throw new Error(`failed to restore \`${path}\`: ${errorText(error)}`)
  }
}
