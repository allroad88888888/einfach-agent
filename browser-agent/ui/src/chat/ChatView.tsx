import { useEffect, useRef, useState, type RefObject } from 'react'
import { AgentStoreProvider, useRootAtomValue } from '@einfach-agent/react-plugin'
import { activeSessionIdAtom, sessionsAtom } from '@einfach-agent/core'
import type { AgentProfile, BrowserAgentClient, SessionPageHost, TextAttachment } from '@einfach-agent/browser-agent'
import { Conversation } from './Conversation'
import { NewSessionView } from '../sessions/NewSessionView'
import { SessionPageView } from '../sessions/SessionPageView'
import { HistoryView } from '../history/HistoryView'

export function ChatView({ client, agents, onConfigure, onOpenSettings, settingsButtonRef, pages }: { client: BrowserAgentClient; agents: readonly AgentProfile[]; onConfigure(): void; onOpenSettings(): void; settingsButtonRef: RefObject<HTMLButtonElement>; pages?: SessionPageHost }) {
  const sessions = useRootAtomValue(sessionsAtom)
  const sessionId = useRootAtomValue(activeSessionIdAtom)
  const session = sessions[sessionId]
  const [agentId, setAgentId] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [preparing, setPreparing] = useState<Record<string, boolean>>({})
  const [attachments, setAttachments] = useState<Record<string, TextAttachment[]>>({})
  const [creating, setCreating] = useState(false)
  const [, updatePages] = useState(0)
  const newButtonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => pages?.subscribe(() => updatePages((value) => value + 1)), [pages])
  const pageContext = pages?.getSessionPage(sessionId)
  const blocked = pages && pageContext?.status !== 'ready' ? pageContext?.message ?? '请先绑定目标页面，再发送消息。' : undefined
  const historyButtonRef = useRef<HTMLButtonElement>(null)
  const selectedAgentId = agents.some((agent) => agent.id === agentId) ? agentId : agents[0]?.id ?? ''
  useEffect(() => {
    if (session?.agentProfile?.agentId) setAgentId(session.agentProfile.agentId)
  }, [session?.agentProfile?.agentId, sessionId])
  useEffect(() => {
    setAttachments((previous) => Object.keys(previous).some((id) => !sessions[id])
      ? Object.fromEntries(Object.entries(previous).filter(([id]) => sessions[id])) : previous)
    setPreparing((previous) => Object.keys(previous).some((id) => !sessions[id])
      ? Object.fromEntries(Object.entries(previous).filter(([id]) => sessions[id])) : previous)
    setDrafts((previous) => Object.keys(previous).some((id) => !sessions[id])
      ? Object.fromEntries(Object.entries(previous).filter(([id]) => sessions[id])) : previous)
  }, [sessions])
  function closeHistory() {
    setHistoryOpen(false)
    requestAnimationFrame(() => historyButtonRef.current?.focus())
  }
  function closeCreate() { setCreating(false); requestAnimationFrame(() => newButtonRef.current?.focus()) }
  return <section className={`bav-panel bav-chat-panel${creating ? ' is-creating' : ''}`}>
    <div className="bav-session-bar" hidden={creating} aria-label="会话工具栏">
      <button ref={historyButtonRef} type="button" className="bav-history-toggle" aria-label="打开历史记录" aria-expanded={historyOpen} title="历史记录" onClick={() => historyOpen ? closeHistory() : setHistoryOpen(true)}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 11a9 9 0 1 1 2.6 7M3 5v6h6M12 7v5l3 2" /></svg><span>历史</span></button>
      <div className="bav-session-heading"><strong title={session?.title}>{creating ? '新建会话' : session?.title ?? '浏览器 Agent'}</strong><small>{agents.find((agent) => agent.id === session?.agentProfile?.agentId)?.name ?? ''}</small></div>
      <button ref={newButtonRef} type="button" className="bav-new-session" aria-label="新建会话" disabled={!selectedAgentId || creating} onClick={() => setCreating(true)}>新建</button>
      <button ref={settingsButtonRef} type="button" className="bav-icon-button" aria-label="打开设置" title="设置" onClick={() => { setHistoryOpen(false); onOpenSettings() }}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 8.25A3.75 3.75 0 1 0 12 15.75 3.75 3.75 0 0 0 12 8.25Z"/><path d="M19.1 13.2c.06-.39.06-2.01 0-2.4l1.68-1.31-1.7-2.94-1.98.8a7.6 7.6 0 0 0-2.08-1.2L14.72 4h-3.4l-.31 2.15c-.75.29-1.45.69-2.08 1.2l-1.98-.8-1.7 2.94 1.68 1.31a7.96 7.96 0 0 0 0 2.4l-1.68 1.31 1.7 2.94 1.98-.8c.63.51 1.33.91 2.08 1.2l.31 2.15h3.4l.31-2.15a7.6 7.6 0 0 0 2.08-1.2l1.98.8 1.7-2.94-1.68-1.31Z"/></svg></button>
    </div>
    <div className="bav-chat-body">
      <div className="bav-chat-content" hidden={historyOpen || creating}>
        {session && pages && <SessionPageView key={`page:${sessionId}`} host={pages} sessionId={sessionId} context={pageContext} />}
        {!agents.length && !session && <div className="bav-empty-state"><strong>还没有 Agent</strong><span>先填写你的接口地址、模型 ID 与 API Key，再创建 Agent。</span><button type="button" onClick={onConfigure}>配置模型与 API Key</button></div>}
        {session ? <AgentStoreProvider store={client.core.sessionAtomScope(sessionId)} key={sessionId}><Conversation client={client} sessionId={sessionId} blocked={blocked} submitting={preparing[sessionId] ?? false} setSubmitting={(value) => setPreparing((previous) => ({ ...previous, [sessionId]: value }))} files={attachments[sessionId] ?? []} setFiles={(files) => setAttachments((previous) => ({ ...previous, [sessionId]: files }))} draft={drafts[sessionId] ?? ''} setDraft={(value) => setDrafts((previous) => ({ ...previous, [sessionId]: value }))} /></AgentStoreProvider> : agents.length > 0 && <div className="bav-empty-state"><strong>开始一段对话</strong><span>点击上方“新建”，或从历史记录继续。</span><button type="button" className="bav-secondary" onClick={() => setHistoryOpen(true)}>浏览历史记录</button></div>}
      </div>
      {historyOpen && !creating && <HistoryView client={client} agents={agents} sessions={Object.values(sessions)} currentId={sessionId} drafts={{ ...Object.fromEntries(Object.entries(attachments).filter(([, files]) => files.length).map(([id]) => [id, '附件草稿'])), ...Object.fromEntries(Object.entries(drafts).filter(([, text]) => text)) }} pages={pages} onClose={closeHistory} onSelect={(id) => { client.core.selectSession(id); closeHistory() }} />}
      {creating && <NewSessionView client={client} agents={agents} initialAgentId={selectedAgentId} pages={pages} onCancel={closeCreate} onCreated={(id) => { setAgentId(id); setHistoryOpen(false); closeCreate() }} />}
    </div>
  </section>
}
