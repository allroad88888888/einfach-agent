import {
  userMessageVersion,
  type UserMessageContent,
} from '@web-agent/ai'
import { sessionsAtom } from '../state/rootAtoms'
import { itemsAtom } from '../state/sessionAtoms'
import { queuedUserMessagesAtom } from '../state/sessionTransientAtoms'
import type { ConversationItem, ModelSettings } from '../state/core.type'
import type { CoreInstance } from './core/coreInstance'

export type UserContentDisposalReason =
  | 'session_removed'
  | 'history_truncated'
  | 'run_stopped'

export interface UserContentDisposalContext {
  sessionId: string
  reason: UserContentDisposalReason
  settings: Readonly<ModelSettings>
}

export type UserContentDisposer = (
  discarded: readonly UserMessageContent[],
  retained: readonly UserMessageContent[],
  context: UserContentDisposalContext,
) => void | Promise<void>

export type UserContentReachability = ReadonlyMap<string, UserMessageContent>

function addContent(
  reachable: Map<string, UserMessageContent>,
  content: UserMessageContent,
): void {
  const version = userMessageVersion(content)
  if (!reachable.has(version)) reachable.set(version, content)
}

/** Captures every user content still reachable from live or queued state. */
export function captureUserContentReachability(
  core: CoreInstance,
  sessionId: string,
): UserContentReachability {
  if (!core.rootStore.getter(sessionsAtom)[sessionId]) return new Map()
  const store = core.getSessionStore(sessionId).store
  const reachable = new Map<string, UserMessageContent>()
  const visitItems = (items: readonly ConversationItem[]) => {
    for (const entry of items) {
      if (entry.item.role === 'user') addContent(reachable, entry.item.content)
    }
  }
  visitItems(store.getter(itemsAtom))
  for (const queued of store.getter(queuedUserMessagesAtom)) {
    addContent(reachable, queued.content)
  }
  return reachable
}

/** Captures retained content across sessions so hosts can protect shared provider references. */
export function captureAllUserContentReachability(
  core: CoreInstance,
): UserContentReachability {
  const reachable = new Map<string, UserMessageContent>()
  for (const sessionId of Object.keys(core.rootStore.getter(sessionsAtom))) {
    for (const [version, content] of captureUserContentReachability(core, sessionId)) {
      if (!reachable.has(version)) reachable.set(version, content)
    }
  }
  return reachable
}

/**
 * Releases newly unreachable provider content without affecting the local mutation.
 *
 * 返回「是否真的把内容交给了 disposer」。调用方靠它判断有没有发生**跨进程边界的不可逆动作**：
 * 没配 disposer、或没有任何内容变成不可达，都属于什么也没发出去，此时不该在撤销账本上立屏障
 * （见 state/undoBarrier.ts）—— 否则每次停止 run 都会白白封掉更早的撤销。
 */
export function disposeUnreachableUserContent(
  core: CoreInstance,
  before: UserContentReachability,
  after: UserContentReachability,
  context: UserContentDisposalContext,
): boolean {
  const dispose = core.config.disposeUserContent
  if (!dispose) return false
  const discarded = Array.from(before)
    .filter(([version]) => !after.has(version))
    .map(([, content]) => content)
  if (discarded.length === 0) return false
  try {
    void Promise.resolve(dispose(discarded, Array.from(after.values()), context)).catch(() => {})
  } catch {
    // Remote cleanup is best-effort and must not roll back a completed local mutation.
  }
  // 已经交出去了：即便远端删除失败，也必须按「发生过」处理 —— 我们无从知道它删没删。
  return true
}

/** @returns 是否真的发出了释放（供调用方决定要不要立撤销屏障）。 */
export function disposeUserContentAfterMutation(
  core: CoreInstance,
  before: UserContentReachability,
  context: UserContentDisposalContext,
): boolean {
  return disposeUnreachableUserContent(
    core,
    before,
    captureAllUserContentReachability(core),
    context,
  )
}
