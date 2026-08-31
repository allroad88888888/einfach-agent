// 左栏：会话列表（P-U2）。契约 U1 —— UI 只读 atom + 调命令。
// ---------------------------------------------------------------------------
// 读：rootStore 的 sessionsAtom / activeSessionIdAtom（在根 rootStore Provider 下）。
// 写：一律走 runtime/commands 的命令（selectSession / removeSession / renameSession）
//   —— 本组件绝不直接 setter atom、不 import writers、不碰 store 实例（U1 边界）。
// 顺序（TU1）：按 updatedAt 倒序（最近活跃在最上）；并列退 createdAt 倒序，再并列按 id 稳定。
// 行内改名（TT4）：双击标题进入编辑（editingId + draft 纯本地 UI 态，不进 atom）；
//   Enter/失焦提交（调 renameSession，trim 空由命令层 no-op 兜底）、Esc 取消；单击行为不变。
// 删除两步确认（TU2）：首击 × 只进入确认态（confirmingId 纯本地 UI 态，至多一行），
//   再击才调 removeSession；失焦 / 鼠标移出该行 / 3s 超时复位；开始改名编辑也复位确认态。

import { useEffect, useRef, useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import { useRootAtomValue } from '@einfach-agent/react-plugin'
import {
  sessionsAtom,
  activeSessionIdAtom,
  selectSession,
  removeSession,
  renameSession,
} from '@einfach-agent/core'

// TU2：删除确认态的自动复位时限。
const CONFIRM_TIMEOUT_MS = 3000

export function SessionList({ workspaceId }: { workspaceId?: string }) {
  const { t } = useLingui()
  const sessions = useRootAtomValue(sessionsAtom)
  const activeId = useRootAtomValue(activeSessionIdAtom)
  // TU1：updatedAt 倒序 → 并列退 createdAt 倒序 → 再并列按 id 稳定（防同刻抖动）。
  const ordered = Object.values(sessions)
    .filter((session) => !workspaceId || session.workspaceId === workspaceId)
    .sort(
      (a, b) =>
        b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
    )

  // 编辑态：正在改名的会话 id + 输入框草稿。
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // 只提交一次守卫：Enter 提交后浏览器还会触发一次 blur（真实 DOM 里 blur 先于卸载），
  //   闭包里的 editingId 是渲染时的旧值判不出来 —— 用 ref 记「本轮编辑已结束」，blur 时跳过。
  const settledRef = useRef(false)

  // 删除确认态（TU2）：至多一行处于「再击才真删」的确认态。
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  // 3s 超时定时器：复位 / 切换确认行 / 卸载时必须清 —— 防泄漏，也防旧定时器误复位新行。
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearConfirmTimer = () => {
    if (confirmTimerRef.current !== null) {
      clearTimeout(confirmTimerRef.current)
      confirmTimerRef.current = null
    }
  }

  const resetConfirm = () => {
    clearConfirmTimer()
    setConfirmingId(null)
  }

  // 卸载时清定时器（clearConfirmTimer 只读 ref，取首渲染闭包即可）。
  useEffect(() => clearConfirmTimer, [])

  const handleRemoveClick = (id: string) => {
    if (confirmingId === id) {
      // 二击：真删 —— 仍走 removeSession 命令（U1 边界不变）。
      resetConfirm()
      removeSession(id)
      return
    }
    // 首击（或另一行确认态中点了本行）：本行进入确认态，重开 3s 超时。
    clearConfirmTimer()
    setConfirmingId(id)
    confirmTimerRef.current = setTimeout(() => {
      confirmTimerRef.current = null
      setConfirmingId(null)
    }, CONFIRM_TIMEOUT_MS)
  }

  const startEdit = (id: string, title: string) => {
    // 开始改名编辑时复位删除确认态，避免同一行「编辑框 + 红色确认」视觉打架（TU2）。
    resetConfirm()
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
      {ordered.map((s) => {
        const isActive = s.id === activeId
        const isConfirming = confirmingId === s.id
        return (
          <div
            key={s.id}
            className={`agentnew-session-item${isActive ? ' active' : ''}`}
            // 鼠标移出该行 → 确认态复位（只复位本行的，别误伤别行）。
            onMouseLeave={() => {
              if (isConfirming) resetConfirm()
            }}
          >
            {editingId === s.id ? (
              <input
                className="agentnew-session-rename-input"
                value={draft}
                autoFocus
                aria-label={t`重命名会话`}
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
              className={`agentnew-session-remove${isConfirming ? ' confirming' : ''}`}
              aria-label={isConfirming ? t`确认删除` : t`删除`}
              onClick={() => handleRemoveClick(s.id)}
              // 按钮失焦 → 确认态复位（点了别处即视为放弃删除）。
              onBlur={() => {
                if (isConfirming) resetConfirm()
              }}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
