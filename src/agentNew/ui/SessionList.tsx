// 左栏：会话列表（P-U2）。契约 U1 —— UI 只读 atom + 调命令。
// ---------------------------------------------------------------------------
// 读：rootStore 的 sessionsAtom / activeSessionIdAtom（在根 rootStore Provider 下）。
// 写：一律走 runtime/commands 的命令（newSession / selectSession / removeSession /
//   renameSession）—— 本组件绝不直接 setter atom、不 import writers、不碰 store 实例（U1 边界）。
// 顺序：按 createdAt 倒序（新建的在最上）。
// 行内改名（TT4）：双击标题进入编辑（editingId + draft 纯本地 UI 态，不进 atom）；
//   Enter/失焦提交（调 renameSession，trim 空由命令层 no-op 兜底）、Esc 取消；单击行为不变。

import { useRef, useState } from 'react'
import { useAtomValue } from '@einfach/react'
import { sessionsAtom, activeSessionIdAtom } from '../state/rootStore'
import { newSession, selectSession, removeSession, renameSession } from '../runtime/commands'

export function SessionList() {
  const sessions = useAtomValue(sessionsAtom)
  const activeId = useAtomValue(activeSessionIdAtom)
  const ordered = Object.values(sessions).sort((a, b) => b.createdAt - a.createdAt)

  // 编辑态：正在改名的会话 id + 输入框草稿。
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // 只提交一次守卫：Enter 提交后浏览器还会触发一次 blur（真实 DOM 里 blur 先于卸载），
  //   闭包里的 editingId 是渲染时的旧值判不出来 —— 用 ref 记「本轮编辑已结束」，blur 时跳过。
  const settledRef = useRef(false)

  const startEdit = (id: string, title: string) => {
    settledRef.current = false
    setEditingId(id)
    setDraft(title)
  }

  const commitEdit = (id: string) => {
    if (settledRef.current) return
    settledRef.current = true
    setEditingId(null)
    renameSession(id, draft)
  }

  const cancelEdit = () => {
    settledRef.current = true
    setEditingId(null)
  }

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
            {editingId === s.id ? (
              <input
                className="agentnew-session-rename-input"
                value={draft}
                autoFocus
                aria-label="重命名会话"
                onFocus={(e) => e.target.select()}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // IME 组合中（拼音选字等）的 Enter/Esc 是给输入法的，不是提交/取消（codex P2）。
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter') commitEdit(s.id)
                  else if (e.key === 'Escape') cancelEdit()
                }}
                onBlur={() => commitEdit(s.id)}
              />
            ) : (
              <button
                type="button"
                className="agentnew-session-title"
                onClick={() => selectSession(s.id)}
                onDoubleClick={() => startEdit(s.id, s.title)}
              >
                {s.title}
              </button>
            )}
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
