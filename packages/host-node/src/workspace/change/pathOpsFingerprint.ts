// 一条路径的内容+结构指纹
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_path_ops.rs（已随 T1 删除）的 `path_fingerprint`。
//
// 用途只有一个：copy / move 登记时记下指纹，回滚前重算一次，对不上就说明这条路径在那次工具
// 调用之后被人动过，于是拒绝回滚而不是覆盖用户的改动。所以指纹必须同时反映**内容**与**结构**
// ——只哈希内容的话，「把 a/x 改名成 a/y」会算出同一个指纹。
//
// 喂给 sha256 的字节序列（逐条对齐 Rust，改一个字节两个宿主就对不上）：
//   1. 相对路径的 UTF-8 字节。根是字面量 `"."`，子项是 `"./name"`、`"./dir/name"`……
//      **不能用 `path.join`**：它会把 `./a` 规范化成 `a`，而 Rust 的 `PathBuf::push` 原样保留。
//   2. `"file\0"` 或 `"dir\0"`。
//   3. 文件：内容原始字节（不解码，二进制文件同样能算）。目录：按文件名排序后逐个递归。
//
// 排序按 **UTF-8 字节序**而不是 JS 的字符串序：Rust 排的是 `OsString`（底层字节），JS 的 `<`
// 比的是 UTF-16 码元。两者只在「BMP 私用区/CJK 兼容区」与「星光平面字符」相邻时给出不同顺序
// （UTF-16 里代理对排在 U+E000 之前，UTF-8 里排在之后）。撞上的概率极低，但撞上时的表现是
// 指纹无缘无故对不上、回滚被拒，没人查得出来。`Buffer.compare` 一行就买断这件事。

import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { Hash } from 'node:crypto'
import { errorText } from '../common/errorText'

/** 算一条路径的指纹（sha256 十六进制小写）。路径不存在、含软链、含特殊文件都会抛。 */
export async function pathFingerprint(path: string): Promise<string> {
  const hasher = createHash('sha256')
  await hashPath(path, '.', hasher)
  return hasher.digest('hex')
}

/**
 * 算不出来就当成「对不上」。
 *
 * 等价 Rust 的 `path_fingerprint(&path).as_deref() != Ok(item.fingerprint.as_str())` —— 那是拿
 * `Result` 和 `Ok(...)` 比，**`Err` 与任何 `Ok` 都不相等**，于是「路径没了」「变成软链了」
 * 「读不动了」全都落进冲突分支，而不是让整条回滚以异常收场。
 *
 * 这一点值得写下来：指纹算不出来时**不该**把异常抛给调用方。被登记的路径被用户删掉是完全正常
 * 的事，正确的回应是「这条改动没法安全回滚，请看冲突列表」，不是「宿主炸了」。
 */
export async function fingerprintOrNull(path: string): Promise<string | null> {
  try {
    return await pathFingerprint(path)
  } catch {
    return null
  }
}

async function hashPath(path: string, relative: string, hasher: Hash): Promise<void> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    throw new Error(`failed to inspect \`${path}\`: ${errorText(error)}`)
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`symbolic links are not supported: \`${path}\``)
  }
  hasher.update(relative, 'utf8')
  if (stats.isFile()) {
    hasher.update('file\0', 'utf8')
    try {
      hasher.update(await readFile(path))
    } catch (error) {
      throw new Error(`failed to read \`${path}\`: ${errorText(error)}`)
    }
    return
  }
  if (!stats.isDirectory()) {
    throw new Error(`unsupported file type: \`${path}\``)
  }
  hasher.update('dir\0', 'utf8')
  let children: string[]
  try {
    children = await readdir(path)
  } catch (error) {
    throw new Error(`failed to read \`${path}\`: ${errorText(error)}`)
  }
  for (const name of [...children].sort(byUtf8Bytes)) {
    // 相对路径手工拼接，见文件头第 1 条；实际的文件系统路径可以放心用 `join`。
    await hashPath(join(path, name), `${relative}${sep}${name}`, hasher)
  }
}

function byUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}
