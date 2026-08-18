// 锁内的纯判断：给定「磁盘上现在是什么」，这次写入到底会做什么
// ---------------------------------------------------------------------------
// 对应 apps/desktop/src/workspace_write_pipeline.rs:238-329 那几段。全部是纯函数，一行 IO 都没有
// ——因为这几条判断正是最容易出错、也最难用集成测试钉住的部分（要造出「旧内容是二进制」「刚好
// 越过可逆预算」「append 到一个不存在的文件」这些组合，走磁盘得建一堆样本）。
//
// 顺序不是随手排的，它就是 Rust 里那几段的先后：
//   1. `upsert` 折算成 create / overwrite（**只看文件在不在**，不看别的）
//   2. 模式本身能不能成立（overwrite 一个不存在的文件 → 拒，并指出出路是 upsert）
//   3. 守卫该不该验、验不验得过
//   4. 写完之后的完整文本是什么（append 要把旧内容接上）
//   5. 这次写入可不可逆（**不影响写不写**，只影响回执与要不要记账）

import { afterExceedsReversibleBudget } from './limitChecks'
import { computeChangeSummary } from './changeSummary'
import { verifyExpectedContent } from './guard'
import { rejectWrite } from './result'
import type { BeforeContent } from './before'
import type { FileChangeSummary } from './changeSummary'
import type { WriteMode } from './types'

/** 折算掉 `upsert` 之后的三种实际写法。 */
export type EffectiveWriteMode = 'create' | 'overwrite' | 'append'

/**
 * `upsert` 的全部语义：文件在就覆盖、不在就新建。
 * 它省掉的是调用方「先读一次探路」的往返，不是一种新写法。
 */
export function resolveEffectiveMode(mode: WriteMode, existed: boolean): EffectiveWriteMode {
  if (mode !== 'upsert') return mode
  return existed ? 'overwrite' : 'create'
}

/**
 * 模式与磁盘现状对不对得上。
 *
 * 只有一条：`overwrite` 要求文件已存在。拒绝时明说出路是 `upsert`——模型最常见的错法就是拿
 * overwrite 去建新文件，不指出这一句它只会换个内容重试。
 * （`create` 撞上已存在的文件不在这里判：那由 `wx` 打开失败时的内核判定给出，无窗口。）
 */
export function rejectImpossibleMode(mode: WriteMode, existed: boolean): void {
  if (mode === 'overwrite' && !existed) {
    rejectWrite(
      'cannot overwrite a file that does not exist; use mode "upsert" to create it when absent',
    )
  }
}

/**
 * 验守卫，或者拒绝一个无处可验的守卫。
 *
 * 三条分支照搬 Rust：
 *   · 覆盖、或**追加到一个已存在的文件** → 正常校验。追加也收守卫是有意的：分块追加失败重试时，
 *     没有前置条件就分不清「上次那段写丢了」和「上次写成功了」，只能重复追加。
 *   · 其余情况（新建，含 `upsert` 撞上不存在的文件）而调用方**给了**守卫 → 拒。守卫表达的是
 *     「我基于某个已知版本改」，这时候静默新建等于把这个前提扔掉。
 *   · 其余情况且没给守卫 → 什么都不做。
 */
export function verifyGuard(
  before: BeforeContent,
  effectiveMode: EffectiveWriteMode,
  existed: boolean,
  expectedOldContent: string | undefined,
  expectedContentHash: string | undefined,
): void {
  if (effectiveMode === 'overwrite' || (effectiveMode === 'append' && existed)) {
    verifyExpectedContent(before, expectedOldContent, expectedContentHash)
    return
  }
  if (expectedOldContent !== undefined || expectedContentHash !== undefined) {
    rejectWrite('optimistic guard was provided but the file does not exist; drop the guard to create it')
  }
}

/**
 * 写完之后整个文件的文本内容；`null` 表示写完之后它不是可表示的文本。
 *
 * `append` 是唯一需要把旧内容接上的模式——回滚要存的是**整个文件**的前后样子，只存追加的那段
 * 的话，撤销会把文件截成追加前的样子之外的任何东西。旧内容读不出来（二进制/超限）时整体退化
 * 成 `null`：接不出完整文本，就没有可逆的资格。
 */
export function computeAfterText(
  effectiveMode: EffectiveWriteMode,
  before: BeforeContent,
  payloadText: string | null,
): string | null {
  if (effectiveMode !== 'append') return payloadText
  if (payloadText === null) return null
  if (before.kind === 'missing') return payloadText
  if (before.kind === 'text') return `${before.text}${payloadText}`
  return null
}

/**
 * 这次写入为什么不可逆；`null` = 可逆。
 *
 * **它不阻止写入**。二进制产物和超预算的大文件照写，只是回执里说明撤不回来——早先的实现是
 * 直接拒绝，结果是「太大/是二进制就不给写」，能力没了而限制还看不见。
 * 判定顺序照搬：旧内容读不出来的理由**优先**（它比「新内容是二进制」更具体）。
 */
export function reversibleReason(before: BeforeContent, afterText: string | null): string | null {
  if (before.kind === 'unsupported') return before.reason
  if (afterText === null) return 'binary content is not reversible'
  return afterExceedsReversibleBudget(afterText) ?? null
}

/**
 * 行级变更摘要；`null` = 这次写入给不出摘要。
 *
 * 两种给得出的情况：旧内容是文本（diff 旧→新），或文件原本不存在（全部算新增）。
 * 「文件存在但没读过旧内容」（普通 append，既没有守卫也没有日志）落在最后一条 `null` 上——
 * 那时手里根本没有旧内容，硬算出来的 diff 会把整个文件说成新增的。
 */
export function summarizeChange(
  before: BeforeContent,
  afterText: string | null,
  existed: boolean,
): FileChangeSummary | null {
  if (afterText === null) return null
  if (before.kind === 'text') return computeChangeSummary(before.text, afterText)
  if (before.kind === 'missing' && !existed) return computeChangeSummary(null, afterText)
  return null
}
