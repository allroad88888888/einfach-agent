// 左栏：会话列表（P-U2）。契约 U1 —— UI 只读 atom + 调命令。
// ---------------------------------------------------------------------------
// 读：rootStore 的 sessionsAtom / activeSessionIdAtom（在根 rootStore Provider 下）。
// 写：一律走 runtime/commands 的命令（newSession / selectSession / removeSession）——
//   本组件绝不直接 setter atom、不 import writers、不碰 store 实例（U1 边界）。
// 顺序：按 createdAt 倒序（新建的在最上）。

import { useAtomValue } from '@einfach/react'
import { sessionsAtom, activeSessionIdAtom } from '../state/rootStore'
import { newSession, selectSession, removeSession } from '../runtime/commands'

export function SessionList() {
  const sessions = useAtomValue(sessionsAtom)
  const activeId = useAtomValue(activeSessionIdAtom)
  const ordered = Object.values(sessions).sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className="agentnew-session-list">
      <button
        type="button"
        className="agentnew-new-session"
        onClick={() => newSession()}
      >
        + 新建对话
      </button>
      {ordered.map((s) => {
        const isActive = s.id === activeId
        return (
          <div
            key={s.id}
            className={`agentnew-session-item${isActive ? ' active' : ''}`}
          >
            <button
              type="button"
              className="agentnew-session-title"
              onClick={() => selectSession(s.id)}
            >
              {s.title}
            </button>
            <button
              type="button"
              className="agentnew-session-remove"
              aria-label="删除"
              onClick={() => removeSession(s.id)}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
