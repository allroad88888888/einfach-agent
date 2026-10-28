import { useEffect, useRef, useState } from 'react'
import type { SessionMeta } from '@einfach-agent/core'
import type { AgentProfile, BrowserAgentClient, SessionPageHost } from '@einfach-agent/browser-agent'
import { HistoryAction, type HistoryActionRequest } from './HistoryAction'

export function HistoryView({ client, agents, sessions, currentId, drafts, onClose, onSelect, pages }: { client: BrowserAgentClient; agents: readonly AgentProfile[]; sessions: readonly SessionMeta[]; currentId: string; drafts: Readonly<Record<string, string>>; onClose(): void; onSelect(id: string): void; pages?: SessionPageHost }) {
  const [query, setQuery] = useState('')
  const [action, setAction] = useState<HistoryActionRequest>()
  const [notice, setNotice] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => { searchRef.current?.focus() }, [])
  const agentName = (session: SessionMeta) => agents.find((agent) => agent.id === session.agentProfile?.agentId)?.name ?? 'Agent 已移除'
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  const filter = query.trim().toLocaleLowerCase()
  const filtered = sorted.filter((session) => `${session.title} ${agentName(session)} ${pages?.getSessionPage(session.id)?.page.title ?? ''} ${pages?.getSessionPage(session.id)?.page.url ?? ''}`.toLocaleLowerCase().includes(filter))
  const groups = new Map<string, SessionMeta[]>()
  for (const session of filtered) {
    const group = dateGroup(session.updatedAt)
    groups.set(group, [...(groups.get(group) ?? []), session])
  }
  function closeAction(message = '') {
    setAction(undefined); setNotice(message)
    requestAnimationFrame(() => searchRef.current?.focus())
  }
  return <section className="bav-session-history" aria-label="会话历史" onKeyDown={(event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    event.preventDefault()
    const menu = event.target instanceof Element ? event.target.closest('details[open]') : null
    if (menu instanceof HTMLDetailsElement) { menu.open = false; menu.querySelector('summary')?.focus() }
    else onClose()
  }}>
    <header className="bav-history-header"><div><h1>历史记录</h1><span>{sessions.length} 个会话</span></div><button type="button" className="bav-secondary" onClick={onClose}>返回对话</button></header>
    {action ? <HistoryAction client={client} action={action} onClose={() => closeAction()} onComplete={closeAction} /> : <>
      <div className="bav-history-search"><input ref={searchRef} type="search" aria-label="搜索会话" placeholder="搜索会话或 Agent" value={query} onChange={(event) => setQuery(event.target.value)} />
        <details className="bav-session-menu"><summary aria-label="历史记录操作" title="管理历史记录">•••</summary><div><button type="button" disabled={!sessions.length} onClick={() => setAction({ kind: 'delete', sessions: sorted.map(({ id, title }) => ({ id, title })) })}>清空历史记录</button></div></details>
      </div>
      {notice && <p role="status" className="bav-feedback">{notice}</p>}
      <div className="bav-history-list">
        {!sessions.length ? <div className="bav-empty-state"><strong>暂无历史记录。</strong><span>新建会话后，会自动保存在这里。</span></div> : !filtered.length ? <div className="bav-empty-state"><strong>没有匹配的会话</strong><span>试试其他关键词。</span><button type="button" className="bav-secondary" onClick={() => { setQuery(''); searchRef.current?.focus() }}>清除搜索</button></div> : [...groups].map(([label, entries]) => <section key={label} className="bav-history-group" aria-label={label}>
          <h2>{label}</h2><ul>{entries.map((session) => <li key={session.id} className={session.id === currentId ? 'is-current' : ''}>
            <button type="button" className="bav-session-link" aria-label={`打开会话：${session.title}`} aria-current={session.id === currentId ? 'page' : undefined} onClick={() => onSelect(session.id)}>
              <span className="bav-session-title">{session.title}</span>
              {pages?.getSessionPage(session.id) && <span className="bav-history-page" title={pages.getSessionPage(session.id)!.page.url}>{pages.getSessionPage(session.id)!.page.title} · {site(pages.getSessionPage(session.id)!.page.url)}</span>}
              <span className="bav-session-meta"><span>{agentName(session)}</span><time dateTime={new Date(session.updatedAt).toISOString()} title={new Date(session.updatedAt).toLocaleString()}>{new Date(session.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{drafts[session.id]?.trim() && <span className="bav-draft-label">草稿</span>}{session.id === currentId && <span className="bav-current-label">当前</span>}</span>
            </button>
            <details className="bav-session-menu"><summary aria-label={`会话操作：${session.title}`} title="会话操作">•••</summary><div>
              <button type="button" aria-label={`重命名会话：${session.title}`} onClick={() => setAction({ kind: 'rename', id: session.id, title: session.title })}>重命名</button>
              <button type="button" aria-label={`删除会话：${session.title}`} onClick={() => setAction({ kind: 'delete', sessions: [{ id: session.id, title: session.title }] })}>删除会话</button>
            </div></details>
          </li>)}</ul>
        </section>)}
      </div>
    </>}
  </section>
}

function dateGroup(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return '今天'
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return date.toLocaleDateString([], { ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' as const } : {}), month: 'long', day: 'numeric' })
}

function site(url: string): string { try { return new URL(url).host } catch { return url } }
