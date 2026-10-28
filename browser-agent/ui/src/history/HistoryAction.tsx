import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { BrowserAgentClient } from '@einfach-agent/browser-agent'

export type HistoryActionRequest =
  | { kind: 'delete'; sessions: readonly { id: string; title: string }[] }
  | { kind: 'rename'; id: string; title: string }

/** Inline confirmation keeps the embedding's surrounding page available. */
export function HistoryAction({ client, action, onClose, onComplete }: { client: BrowserAgentClient; action: HistoryActionRequest; onClose(): void; onComplete(message: string): void }) {
  const id = useId()
  const [title, setTitle] = useState(action.kind === 'rename' ? action.title : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (action.kind === 'rename') { inputRef.current?.focus(); inputRef.current?.select() }
    else cancelRef.current?.focus()
  }, [action.kind])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      if (action.kind === 'delete') {
        await client.deleteSessions(action.sessions.map((session) => session.id))
        onComplete(`已删除 ${action.sessions.length} 个会话。`)
      } else {
        if (!title.trim()) return
        client.core.renameSession(action.id, title)
        onComplete('会话已重命名。')
      }
    } catch (value) { setError(value instanceof Error ? value.message : '操作失败，请重试') }
    finally { setBusy(false) }
  }
  return <form className="bav-history-action" role={action.kind === 'delete' ? 'alertdialog' : 'dialog'} aria-labelledby={`${id}-title`} aria-describedby={action.kind === 'delete' ? `${id}-description` : undefined} onSubmit={submit} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onClose() }
  }}>
    <h2 id={`${id}-title`}>{action.kind === 'delete' ? `删除 ${action.sessions.length} 个会话？` : '重命名会话'}</h2>
    {action.kind === 'delete' ? <>
      <p className="bav-history-delete-titles">{action.sessions.length === 1 ? action.sessions[0]?.title : `将删除确认时选中的 ${action.sessions.length} 个会话。`}</p>
      <p id={`${id}-description`}>消息与撤销历史将一并删除，无法恢复。不会撤销网页上已执行的操作，也不会删除 Agent 和模型配置。</p>
    </> : <label>会话名称<input ref={inputRef} value={title} maxLength={48} required disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>}
    {error && <p role="alert" className="bav-error">{error}</p>}
    <div className="bav-form-actions">
      <button ref={cancelRef} type="button" className="bav-secondary" disabled={busy} onClick={onClose}>取消</button>
      <button className={action.kind === 'delete' ? 'bav-danger' : ''} disabled={busy || (action.kind === 'rename' && !title.trim())}>{busy ? '处理中…' : action.kind === 'delete' ? '确认删除' : '保存名称'}</button>
    </div>
  </form>
}
