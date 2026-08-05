import {
  userMessageVersion,
  type UserMessageContent,
} from '@web-agent/ai'
import { sessionsAtom } from '../state/rootAtoms'
import { checkpointsAtom, itemsAtom } from '../state/sessionAtoms'
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

/** Captures every user content still reachable from live, queued, or checkpoint state. */
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
  for (const checkpoint of store.getter(checkpointsAtom)) {
    visitItems(checkpoint.items)
    for (const queued of checkpoint.recovery?.queuedUserMessages ?? []) {
      addContent(reachable, queued.content)
    }
  }
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

/** Releases newly unreachable provider content without affecting the local mutation. */
export function disposeUnreachableUserContent(
  core: CoreInstance,
  before: UserContentReachability,
  after: UserContentReachability,
  context: UserContentDisposalContext,
): void {
  const dispose = core.config.disposeUserContent
  if (!dispose) return
  const discarded = Array.from(before)
    .filter(([version]) => !after.has(version))
    .map(([, content]) => content)
  if (discarded.length === 0) return
  try {
    void Promise.resolve(dispose(discarded, Array.from(after.values()), context)).catch(() => {})
  } catch {
    // Remote cleanup is best-effort and must not roll back a completed local mutation.
  }
}

export function disposeUserContentAfterMutation(
  core: CoreInstance,
  before: UserContentReachability,
  context: UserContentDisposalContext,
): void {
  disposeUnreachableUserContent(
    core,
    before,
    captureAllUserContentReachability(core),
    context,
  )
}
