import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AgentProfile, BrowserAgentClient, SessionPage, SessionPageHost } from '@einfach-agent/browser-agent'
import { PagePicker } from './PagePicker'

export function NewSessionView({ client, agents, initialAgentId, pages, onCancel, onCreated }: { client: BrowserAgentClient; agents: readonly AgentProfile[]; initialAgentId: string; pages?: SessionPageHost; onCancel(): void; onCreated(agentId: string): void }) {
  const [agentId, setAgentId] = useState(initialAgentId)
  const [title, setTitle] = useState('')
  const [page, setPage] = useState<SessionPage>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  async function create(event: FormEvent) {
    event.preventDefault()
    if (busy || !agentId || (pages && (!page || page.unavailableReason))) return
    setBusy(true); setError('')
    try {
      if (pages && page) await pages.createSession(agentId, { title, page })
      else await client.createSession(agentId, { title })
      onCreated(agentId)
    } catch (value) { setError(value instanceof Error ? value.message : '创建失败，请重试。') }
    finally { setBusy(false) }
  }
  return <section className="bav-session-setup" aria-label="新建会话" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); if (!busy) onCancel() } }}>
    <header className="bav-history-header"><h1 ref={heading} tabIndex={-1}>新建会话</h1><button type="button" className="bav-secondary" disabled={busy} onClick={onCancel}>取消</button></header>
    <form className="bav-session-form" onSubmit={create}>
      <label>Agent<select aria-label="使用 Agent" value={agentId} disabled={busy} onChange={(event) => setAgentId(event.target.value)}><option value="">选择 Agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
      {pages && <PagePicker host={pages} page={page} onChange={setPage} disabled={busy} />}
      <label>对话标题 <small>可选</small><input aria-label="对话标题" maxLength={48} placeholder="例如：核对本月项目表单" value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} /><span className="bav-field-help">留空时，根据第一条消息自动命名。</span></label>
      {error && <p role="alert" className="bav-error">{error}</p>}
      <button className="bav-create-submit" disabled={busy || !agentId || !agents.some((agent) => agent.id === agentId) || Boolean(pages && (!page || page.unavailableReason))}>{busy ? '正在连接并创建…' : '创建会话'}</button>
    </form>
  </section>
}
