// 会话槽位穷举表 —— 「一个会话的完整状态」这句话在代码里的唯一落点。
// ---------------------------------------------------------------------------
// 为什么要有这张表：在它之前，同一份名单被**手工维护了两遍**——`recoveryProjection` 的
// capture/apply allowlist，以及（接入事务日志后）undo 的 applier 注册表。两份名单会漂移，
// 而漏一项不报错：恢复出来的会话少一块，或者 undo 越过某个 atom 后状态自相矛盾。
// 恢复树红线 10「唯一副本必须进 allowlist」正是为手工名单而立的，它的退场条件就是这张表。
//
// 判据不是「这个 atom 看起来像不像运行态」，而是**这份内容除了它自己还活在哪里**。
// 只要一段用户或模型产生的内容在别处没有第二份，它就必须在这张表里。反例见红线 10：
// `pendingArtifacts` 的正文只活在 atom 里（`save_file` 只回 id 与字节数），
// `composerDraft` 在回退/撤回那一刻成为用户原话的唯一副本。
//
// **不在表里的会话 atom 必须能重建**，三类归宿之一：能从别处算回来（`contextStats` 下次调用重算）、
// 有明确的补偿设计（`browser-action` 要求模型把卡片内容写进最终回复）、或刷新即恢复安全默认
// （`alwaysAllowedTools` 的危险工具授权不跨重启）。说不出机制 = 缺口，不是设计。
//
// 表里每一项都必须是 einfach 的**源子 atom**：只有源子 atom 能被安全地写回一个历史旧值。
// 派生 atom（真相在上游）与命令 atom（write 是动作而非赋值）写回都会出错，而且是静默出错。
// 这条由本文件模块级的 `findNonSourceSessionSlots()` 调用在加载时机械保证，不靠 review。

import { isSourceAtom, type AtomEntity, type Setter } from '@einfach/core'
import { EMPTY_EXECUTION_GRAPH, executionGraphAtom } from '../execution/graph'
import {
  contextCheckpointAtom,
  itemsAtom,
  planAtom,
  planStageCheckpointsAtom,
  runAtom,
} from './sessionAtoms'
import {
  composerDraftAtom,
  pendingArtifactsAtom,
  pendingQuestionAnswersAtom,
  queuedUserMessagesAtom,
} from './sessionTransientAtoms'
import { subagentContinuationsAtom } from './subagentContinuationAtoms'

/**
 * 一个槽位：它的 atom 身份，加上「把它推回默认值」这个动作。
 *
 * 为什么默认值以闭包形式给、而不是作为 `cleared: State` 字段：槽位表是**异构**的
 * （`AtomEntity<ConversationItem[]>`、`AtomEntity<RunState | undefined>` …），按 key 遍历时
 * TypeScript 只能看到联合类型，无法证明某一项的 atom 与它的默认值是同一个 `State`。
 * 让 `slot()` 在构造时把具体类型闭进去，类型断言就只出现在那一处、且在类型可证对齐的地方。
 * 后面要给槽位加 `record(before, after)` 之类的能力时，同一个形状继续适用。
 *
 * `clear` 不是可选的美化字段：hydrate 可以复用一个已经装过别的会话的 Core，此时没有有效恢复
 * 记录的会话必须把每个槽位显式推回默认值，否则上一份投影会残留下来，而且不报错。
 */
export interface SessionSlot {
  /** 仅用于身份判定（源子 atom 校验），不用于读写 —— 读写一律走本槽位自带的动作。 */
  readonly atom: AtomEntity<unknown>
  /** 把该槽位写回「这个会话什么都没发生过」时的值。 */
  clear(set: Setter): void
}

function slot<State>(atom: AtomEntity<State>, cleared: State): SessionSlot {
  return {
    atom: atom as AtomEntity<unknown>,
    clear: (set) => set(atom, cleared),
  }
}

/**
 * 会话的全部持久槽位。**新增会话内容 atom 时，要么进这张表，要么在上面三类归宿里选一类并说明。**
 *
 * key 是**逻辑名**，不是 atom 的变量名：它会进落盘记录（恢复快照字段、事务日志的 op.key），
 * 所以改名等于改格式。atom 实例是进程内对象，绝不落盘。
 */
export const SESSION_SLOTS = {
  items: slot(itemsAtom, []),
  contextCheckpoint: slot(contextCheckpointAtom, undefined),
  run: slot(runAtom, undefined),
  plan: slot(planAtom, undefined),
  planStageCheckpoints: slot(planStageCheckpointsAtom, []),
  queuedUserMessages: slot(queuedUserMessagesAtom, []),
  pendingQuestionAnswers: slot(pendingQuestionAnswersAtom, {}),
  pendingArtifacts: slot(pendingArtifactsAtom, []),
  composerDraft: slot(composerDraftAtom, ''),
  executionGraph: slot(executionGraphAtom, EMPTY_EXECUTION_GRAPH),
  subagentContinuations: slot(subagentContinuationsAtom, []),
} as const

export type SessionSlotKey = keyof typeof SESSION_SLOTS

/** 稳定的槽位遍历顺序（按 key 排序），供需要确定性的路径复用。 */
export const SESSION_SLOT_KEYS: readonly SessionSlotKey[] =
  Object.keys(SESSION_SLOTS).sort() as SessionSlotKey[]

/**
 * 校验每个槽位都是源子 atom，返回不合格的 key。
 *
 * 单独导出而不是在模块顶层直接抛：让测试能断言「这条校验本身有效」，而不只是
 * 「模块能加载」。运行时由下面的模块级调用保证——写错了在 import 阶段就炸，
 * 而不是等到某次 undo 静默算错值。
 */
export function findNonSourceSessionSlots(): SessionSlotKey[] {
  return SESSION_SLOT_KEYS.filter((key) => !isSourceAtom(SESSION_SLOTS[key].atom))
}

const nonSource = findNonSourceSessionSlots()
if (nonSource.length > 0) {
  throw new Error(
    `SESSION_SLOTS 只接受源子 atom（派生 / 命令 atom 写回历史值会静默出错）：${nonSource.join(', ')}`,
  )
}
