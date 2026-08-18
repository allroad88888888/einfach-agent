// 条目文件的读、写与状态更新
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_store.rs 的 `read_entry` / `write_entry` /
// `update_status`。本文件是本域**唯一**碰条目文件的地方；命名与收窄两件纯逻辑分别在
// entryPaths.ts 与 parseChangeSet.ts。
//
// ═══ 落盘为什么复用 common 的 `atomicWrite`，而不是像 N7 那样另写一份 ═══
// N7（配置读写）不能复用，理由是**权限语义相反**：工作区那份继承原文件权限，配置那份必须强制
// 0600。变更日志这边没有这种冲突——条目文件是宿主自己建、自己改的，对权限没有要求：新建时目标
// 不存在，`atomicWrite` 的权限回填退化成空操作；改状态时目标是上一次自己写的那份，回填等于原样
// 保留。于是复用不引入任何不想要的语义，反倒白拿三样东西：
//
//   · **fsync**。Rust 侧的 `write_entry` 是 `fs::write` + `fs::rename`，没有 fsync。这份文件是
//     「这次改动可撤销」的唯一凭据，掉电后目录项指向一个内容为空洞的新文件，症状就是那次改动
//     永久撤不回来、且不报错——这正是本域存在的理由。多一次 fsync 是**修掉 Rust 的一处欠账**，
//     不是换口径：所有可观测输出（条目内容、成功/失败）逐字相同。同类先例见 common/index.ts
//     记的 UTF-8 分块解码。
//   · **失败时清掉临时文件**。Rust 的 rename 失败会把 `.{id}.tmp` 留在日志目录里，之后没人回收。
//   · **临时名带 pid + 纳秒**。Rust 用固定的 `.{id}.tmp`；change id 唯一时撞不上，但同一个 id 的
//     两次状态更新并发时会互相踩。
//
// **一处有意的文案差异**：Rust 把「写临时文件失败」和「rename 失败」分成 `failed to write
// workspace change` / `failed to commit workspace change` 两句；`atomicWrite` 自己已经带了阶段
// 信息（`failed to write temporary file` / `failed to replace target file`），所以这里统一用前一
// 句作外层前缀，阶段仍然读得出来，但不与 Rust 逐字相同。要按前缀字符串反查阶段再改写文案，等于
// 让两个模块靠消息文本耦合——那比这点差异糟得多。
//
// Rust 侧 `write_entry` / `update_status` 里那几行 `log::info!(target: "web_agent::perf", ...)`
// 没有搬：Node 宿主还没有对应的 perf 日志出口，凭空造一个不属于本卡。

import { mkdir, readFile } from 'node:fs/promises'
import { atomicWrite } from '../common/atomicWrite'
import { errorText } from '../common/errorText'
import { entryPath } from './entryPaths'
import { parseChangeSet } from './parseChangeSet'
import type { ChangeStatus, WorkspaceChangeSet } from './types'

/** 读回一份条目。文件读不到与内容坏掉是两句不同的错，照抄 Rust——出路完全不同。 */
export async function readEntry(
  directory: string,
  changeId: string,
): Promise<WorkspaceChangeSet> {
  let content: string
  try {
    content = await readFile(entryPath(directory, changeId), 'utf8')
  } catch (error) {
    throw new Error(`failed to read change set \`${changeId}\`: ${errorText(error)}`)
  }
  try {
    return parseChangeSet(JSON.parse(content))
  } catch (error) {
    throw new Error(`invalid change set \`${changeId}\`: ${errorText(error)}`)
  }
}

/** 整份落盘（新建与覆盖同一条路径）。目录不存在会被创建。 */
export async function writeEntry(directory: string, entry: WorkspaceChangeSet): Promise<void> {
  try {
    await mkdir(directory, { recursive: true })
  } catch (error) {
    throw new Error(`failed to create workspace change journal: ${errorText(error)}`)
  }
  let encoded: string
  try {
    encoded = JSON.stringify(entry)
  } catch (error) {
    throw new Error(`failed to encode workspace change: ${errorText(error)}`)
  }
  try {
    await atomicWrite(entryPath(directory, entry.id), encoded)
  } catch (error) {
    throw new Error(`failed to write workspace change: ${errorText(error)}`)
  }
}

/**
 * 读—改—写地更新状态。
 *
 * 刻意保持「整份重写」而不是就地改一个键：条目里除 status 外的内容在登记之后不再变化，重写的
 * 代价是一次序列化，换来的是「磁盘上永远是一份完整合法的 JSON」。
 */
export async function updateStatus(
  directory: string,
  changeId: string,
  status: ChangeStatus,
): Promise<void> {
  const entry = await readEntry(directory, changeId)
  entry.status = status
  await writeEntry(directory, entry)
}
