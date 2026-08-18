// 临界区：读旧内容 → 验守卫 → 记账 → 落盘 → 收尾
// ---------------------------------------------------------------------------
// 对应 apps/desktop/src/workspace_write_pipeline.rs:216-406。**这一整段必须在写锁里跑**
// （由 pipeline.ts 用 `withPathLock` 包住），理由是 W6 那条：临界区中间至少让出两次
// （读 before、写盘），没有锁时守卫会拿**自己那次读到的**过期快照自证清白，然后整份覆盖掉
// 别人刚写进去的内容。把它单独成文件，就是为了让「哪些步骤必须在锁里」一眼可见——
// 少括一步不会报错，只会在并发时偶尔吃掉一次写入。
//
// 【顺序里有三处不能动】
//  1. **先记账再动手**（`prepareChangeSet` 在写盘之前）。反过来的话，两步之间崩溃就是
//     「改动已发生、日志没有」——那次改动永久撤不回来。反之记了账而写失败，只是留下一条状态
//     停在 `prepared` 的孤儿账，`discardPreparedChange` 正是为它准备的。**宁可多一条账。**
//  2. **旧内容只读一次**，守卫、日志、摘要三方共用。各读各的话，三次读之间文件可能变，
//     回滚会把一份从未存在过的状态写回磁盘。
//  3. **dry run 停在落盘之前、但在全部校验之后**：它的价值就是提前知道这次写会不会被拒、
//     会改什么。所以守卫不匹配在 dry run 下同样报错，且预留的账要当场丢掉。
//
// 【可执行位与原子写的权限回填，谁先谁后】
// `atomicWrite` 是「临时文件 → fsync → **回填目标文件当时的权限** → rename」。回填这一步是
// 覆盖不丢可执行位的原因：没有它，rename 会把 umask 决定的临时文件权限（通常 0644）带过来，
// 脚本几周后突然「跑不了了」。`executable` 是调用方的**显式**要求，落在内容写完之后、在
// 「已经继承好的那份权限」之上再动一次：置位是镜像读权限，清位是抹掉 0o111。
//
// 反过来（先 chmod 再写内容）**不是等价的**，两种模式各坏一半：`create` 时文件还不存在，
// chmod 直接 ENOENT；`overwrite` 时倒是能跑——因为 atomicWrite 回填的是**目标当时**的权限，
// 刚 chmod 上去的位会被原样继承下来。也就是说先做只在 overwrite 这一路碰巧对。
// 「写完之后」是唯一对四种模式都成立的位置。

import { stat } from 'node:fs/promises'
import { atomicWrite, errorText } from '../common'
import { discardPreparedChange, markChangeApplied, prepareChangeSet } from '../change/prepare'
import { applyExecutableBit, writeAppend, writeCreate } from './fsOps'
import { beforeExisted, beforeText, readBeforeContent } from './before'
import {
  computeAfterText,
  rejectImpossibleMode,
  resolveEffectiveMode,
  reversibleReason,
  summarizeChange,
  verifyGuard,
} from './pipelinePlan'
import { rejectWrite } from './result'
import type { BeforeContent } from './before'
import type { EffectiveWriteMode } from './pipelinePlan'
import type { WorkspaceChangeContext, WorkspaceChangeSummary } from '../change/types'
import type { WorkspaceWriteResult } from './result'
import type { WritePayload } from './pipelinePayload'
import type { ResolvedWriteTarget, WriteMode } from './types'

/** 临界区要知道的全部事实。调用方（pipeline.ts）在进锁之前已经把它们都解析好了。 */
export interface WriteCriticalSection {
  target: ResolvedWriteTarget
  workspaceRoot: string
  mode: WriteMode
  payload: WritePayload
  expectedOldContent?: string
  expectedContentHash?: string
  executable?: boolean
  dryRun: boolean
  /** 有值才记账。值来自命令入参里的 `change_context`——没带就是一次不可回滚的直接写。 */
  journal?: { directory: string; context: WorkspaceChangeContext }
}

/** 已经落盘、等着被确认或丢弃的一条账。 */
interface PreparedChange {
  directory: string
  summary: WorkspaceChangeSummary
}

/** 在写锁里跑完一次写入。按设计的拒绝一律抛 `WriteRejection`，由 pipeline.ts 折成回执。 */
export async function runWriteCriticalSection(
  input: WriteCriticalSection,
): Promise<WorkspaceWriteResult> {
  const guardRequested =
    input.expectedOldContent !== undefined || input.expectedContentHash !== undefined
  // append 自己用不着旧字节，只有日志需要——所以不记账、不验守卫的追加不读文件（大归档的追加
  // 因此不必把整个文件读进内存）。
  const needsBefore =
    input.journal !== undefined ||
    guardRequested ||
    input.mode === 'overwrite' ||
    input.mode === 'upsert'
  const before: BeforeContent = needsBefore
    ? await readBeforeContent(input.target.absolutePath)
    : { kind: 'missing' }
  const existed = needsBefore ? beforeExisted(before) : await pathExists(input.target.absolutePath)

  const effectiveMode = resolveEffectiveMode(input.mode, existed)
  rejectImpossibleMode(input.mode, existed)
  verifyGuard(before, effectiveMode, existed, input.expectedOldContent, input.expectedContentHash)

  const afterText = computeAfterText(effectiveMode, before, input.payload.text)
  const reason = reversibleReason(before, afterText)
  const prepared = await prepareChange(input, before, afterText, reason)
  const changeSummary = summarizeChange(before, afterText, existed)

  if (input.dryRun) {
    if (prepared) await discardPreparedChange(prepared.directory, prepared.summary.id)
    // 「会不会改到东西」：算不出摘要时按**会改**报（那说明连旧内容都读不出来，无从断言不变）。
    const wouldChange = changeSummary
      ? changeSummary.linesAdded > 0 || changeSummary.linesRemoved > 0
      : true
    return buildResult(input, { effectiveMode, existed, changeSummary, reason }, { wouldChange })
  }

  try {
    await writePayload(effectiveMode, input.target.absolutePath, input.payload.bytes)
    // 可执行位失败也算这次写入失败（Rust 的 `.and_then`）：内容已经在盘上了，但账要丢掉、
    // 回执是失败。照搬——这条语义值得两边一起重新想，但不该由移植卡单方面改。
    if (input.executable !== undefined) {
      await applyExecutableBit(input.target.absolutePath, input.executable)
    }
  } catch (error) {
    if (prepared) await discardPreparedChange(prepared.directory, prepared.summary.id)
    throw error
  }

  if (prepared) {
    // 标记失败**不影响回执**：文件已经写成功了，说它失败会让调用方以为没写。留下的是一条
    // 状态停在 `prepared` 的账，回滚仍然认它（`prepared` 与 `applied` 都是可撤销的）。
    // Rust 这里打一条 warn 日志；Node 宿主还没有日志出口，所以只能吞——见报告。
    await markChangeApplied(prepared.directory, prepared.summary.id).catch(() => {})
  }
  return buildResult(
    input,
    { effectiveMode, existed, changeSummary, reason },
    { prepared, bytesWritten: input.payload.bytes.length },
  )
}

/**
 * 动手之前把「原来长什么样」记进变更日志。
 *
 * 三个条件缺一不做账：带了 `change_context`、这次写入可逆、写完之后有完整文本。不可逆的写入
 * 记不出有意义的账——回滚要靠日志里的完整前后文本，而那正是「不可逆」意味着拿不到的东西。
 */
async function prepareChange(
  input: WriteCriticalSection,
  before: BeforeContent,
  afterText: string | null,
  reason: string | null,
): Promise<PreparedChange | undefined> {
  const journal = input.journal
  if (journal === undefined || reason !== null || afterText === null) return undefined
  try {
    const summary = await prepareChangeSet(journal.directory, journal.context, input.workspaceRoot, [
      { path: input.target.displayPath, before: beforeText(before), after: afterText },
    ])
    return { directory: journal.directory, summary }
  } catch (error) {
    return rejectWrite(errorText(error))
  }
}

function writePayload(
  effectiveMode: EffectiveWriteMode,
  absolutePath: string,
  bytes: Uint8Array,
): Promise<void> {
  // create 保持 `wx`（拒绝已存在的文件是这个模式的全部意义，rename 会绕过它）；
  // overwrite 走临时文件 + rename，崩在中途也不会留下被截断的目标；
  // append 直接以追加模式打开。
  if (effectiveMode === 'create') return writeCreate(absolutePath, bytes)
  if (effectiveMode === 'overwrite') return atomicWrite(absolutePath, bytes)
  return writeAppend(absolutePath, bytes)
}

interface ResultFacts {
  effectiveMode: EffectiveWriteMode
  existed: boolean
  changeSummary: WorkspaceWriteResult['change_summary']
  reason: string | null
}

/**
 * 拼回执。键的**书写顺序**就是 Rust struct 的字段声明顺序——serde 按声明序输出、
 * `JSON.stringify` 按插入序输出，对齐了两个宿主写出的 JSON 才逐字节相同（W14 定下的约定）。
 */
function buildResult(
  input: WriteCriticalSection,
  facts: ResultFacts,
  outcome: { prepared?: PreparedChange; bytesWritten?: number; wouldChange?: boolean },
): WorkspaceWriteResult {
  return {
    ok: true,
    path: input.target.displayPath,
    bytes_written: outcome.bytesWritten ?? 0,
    created: !facts.existed,
    overwritten: facts.effectiveMode === 'overwrite',
    appended: facts.effectiveMode === 'append',
    error: null,
    change_set: outcome.prepared?.summary ?? null,
    change_summary: facts.changeSummary,
    reversible: facts.reason === null,
    ...(facts.reason !== null ? { reversible_reason: facts.reason } : {}),
    dry_run: input.dryRun,
    would_change: outcome.wouldChange ?? true,
  }
}

/** 等价 Rust 的 `Path::exists()`：跟随符号链接，任何错误都算「不存在」。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
