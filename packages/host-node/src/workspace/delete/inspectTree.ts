// 删之前先把整棵树走一遍：能不能整份备份下来，现在就要有答案
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_delete.rs 的 `inspect_tree`。
//
// ═══ 为什么必须**先**走一遍，而不是边复制边数 ═══
// 可恢复删除的备份是「把整棵树复制进 `<changeId>.payload`」。如果不预扫，超限只能在复制到一半
// 时才发现，那一刻磁盘上已经有半棵树的副本、日志里已经有一条 `prepared` 的账，而原件一个字节
// 都还没删——清理得干净是运气好，清理失败就留下一条指向残缺载荷的账。预扫的代价是多走一遍
// 目录（元数据都在 page cache 里，很便宜），换来的是**拒绝发生在任何东西被改动之前**。
//
// ═══ 树里出现符号链接一律拒（整次删除，不是跳过那一条）═══
// 复制软链有两种同样合理的语义——拷贝链接本身，或拷贝它指向的东西——选哪一种都会让「恢复」
// 还原出一个和原来不同的东西（见 change/pathOpsCopy.ts 同一段理由）。这里在**预扫**阶段就拒，
// 于是 `copyPath` 里那条针对软链的拒绝在删除链路上是第二道防线而非第一道：等到复制时才发现，
// 前面已经登记了一条账、复制了半棵树。
//
// 顺带一提被拒的是**整次删除**：不是「跳过那条软链、删掉其余」。删一半再告诉用户「另一半没删」
// 是最难收拾的结果。
//
// ═══ 计数顺序照抄，不要「优化」═══
// Rust 的顺序是：先加计数 → 文件再加字节 → **然后**判超限 → 最后才递归子项。所以第 20001 个
// 条目一被看见就停手，不会先把它的整棵子树走完。递归形态也照搬（`copyPath` 同样是递归）：
// 深度很大的树会吃掉调用栈，但两个宿主同款，不是 Node 侧单独引入的性质。

import { lstat, readdir } from 'node:fs/promises'
import { sep } from 'node:path'
import { errorText } from '../common/errorText'
import { exceedsDeleteBudget, tooLargeMessage } from './limits'

/** 走过的量。用一个可变对象在递归里穿，等价 Rust 的 `&mut u64` 两个出参。 */
interface TreeBudget {
  entries: number
  bytes: number
}

/**
 * 确认这条路径（文件或整棵目录树）可以被完整备份。能就静默返回，不能就抛——文案即模型可见的
 * 拒绝理由。
 *
 * **只读**：本函数不改任何东西，调用方在它返回之后才可以开始登记与复制。
 */
export async function inspectDeleteTree(path: string): Promise<void> {
  await walk(path, { entries: 0, bytes: 0 })
}

async function walk(path: string, budget: TreeBudget): Promise<void> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    throw new Error(`failed to inspect \`${path}\`: ${errorText(error)}`)
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`symbolic links are not supported by recoverable delete: \`${path}\``)
  }

  budget.entries += 1
  // 只有**文件**计入字节。目录项自身的 size 是文件系统的内部记账（ext4 上常年 4096），
  // 把它算进来等于按目录个数虚增预算，而那个数与「恢复时要写回多少内容」毫无关系。
  if (stats.isFile()) budget.bytes += stats.size
  if (exceedsDeleteBudget(budget.entries, budget.bytes)) throw new Error(tooLargeMessage())

  if (!stats.isDirectory()) return
  let children: string[]
  try {
    children = await readdir(path)
  } catch (error) {
    throw new Error(`failed to read \`${path}\`: ${errorText(error)}`)
  }
  for (const name of children) {
    // 用 `${path}${sep}${name}` 而不是 `join`：`join` 会顺手做词法规范化，而 readdir 给回来的
    // 就是单个条目名，没有什么可规范化的——少一层「它到底动没动我的路径」的疑问。
    await walk(`${path}${sep}${name}`, budget)
  }
}
