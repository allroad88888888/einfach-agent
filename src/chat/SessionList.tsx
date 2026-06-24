import type { Store } from '@einfach/core'
import { useAtomValue, useStore } from '@einfach/react'
import {
  activeSessionIdAtom,
  createSession,
  deleteSession,
  selectSession,
  sessionsAtom,
} from '../agent/state/atoms'
import { cancelSessionRun } from '../agent/runtime/loop'
import type { AgentSession } from '../agent/runtime/types'

function sortByUpdated(sessions: Record<string, AgentSession>): AgentSession[] {
  return Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt)
}

function removeSession(store: Store, sessionId: string) {
  // RF2: cancel any in-flight run for this session before removing it, so its
  // controller is aborted and a late write-back can't resurrect a deleted session.
  cancelSessionRun(store, sessionId)
  deleteSession(store, sessionId)
}

export function SessionList() {
  const store = useStore()
  const sessions = useAtomValue(sessionsAtom)
  const activeId = useAtomValue(activeSessionIdAtom)
  const ordered = sortByUpdated(sessions)

  return (
    <aside className="session-list" aria-label="会话列表">
      <header className="session-list-header">
        <h2 className="session-list-title">会话</h2>
        <button
          type="button"
          className="primary-button session-new-button"
          onClick={() => createSession(store)}
        >
          新建会话
        </button>
      </header>
      <ul className="session-list-items">
        {ordered.map((session) => {
          const isActive = session.id === activeId
          return (
            <li
              key={session.id}
              className={`session-item${isActive ? ' session-item--active' : ''}`}
            >
              <button
                type="button"
                className="session-item-select"
                aria-current={isActive ? 'true' : undefined}
                onClick={() => selectSession(store, session.id)}
              >
                <span className="session-item-title">{session.title}</span>
                <span className={`session-item-status session-item-status--${session.status}`} />
              </button>
              <button
                type="button"
                className="session-item-delete"
                aria-label={`删除 ${session.title}`}
                title="删除会话"
                onClick={() => removeSession(store, session.id)}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
