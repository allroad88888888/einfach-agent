import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react'
import { AgentStoreProvider, useAgentAtomValue, useRootAtomValue } from '@einfach-agent/react-plugin'
import { browserCardsAtom, itemsAtom, pendingQuestionAnswersAtom, runAtom, runtimeTranscriptEventsAtom, sessionsAtom } from '@einfach-agent/core'
import type { AgentProfile, BrowserAgentClient } from '@einfach-agent/browser-agent'
import { ConversationTimeline } from './ConversationTimeline'
import { DecisionCards } from './DecisionCards'

export function ChatView({ client, agents }: { client: BrowserAgentClient; agents: readonly AgentProfile[] }) {
  const sessions = Object.values(useRootAtomValue(sessionsAtom))
  const [agentId, setAgentId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => { if (sessionId && !sessions.some((session) => session.id === sessionId)) setSessionId('') }, [sessionId, sessions])
  async function create() {
    try { const id = await client.createSession(agentId); client.core.selectSession(id); setSessionId(id); setNotice('') }
    catch (error) { setNotice(errorText(error)) }
  }
  return <section className="bav-panel bav-chat-panel">
    <div className="bav-session-bar">
      <label>使用 Agent<select aria-label="使用 Agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">选择 Agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · r{agent.revision}</option>)}</select></label>
      <button type="button" disabled={!agentId} onClick={create}>新建会话</button>
      <label>会话<select aria-label="会话" value={sessionId} onChange={(event) => { setSessionId(event.target.value); if (event.target.value) client.core.selectSession(event.target.value) }}><option value="">选择会话</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label>
    </div>
    {notice && <p role="alert" className="bav-error">{notice}</p>}
    {!agents.length && <div className="bav-empty-state"><strong>还没有 Agent</strong><span>前往配置页创建模型连接和 Agent 后，即可开始对话。</span></div>}
    {sessionId ? <AgentStoreProvider store={client.core.sessionAtomScope(sessionId)} key={sessionId}><Conversation client={client} sessionId={sessionId} /></AgentStoreProvider> : agents.length > 0 && <div className="bav-empty-state"><strong>选择一个会话</strong><span>也可以从上方选择 Agent 并新建会话。</span></div>}
  </section>
}

function Conversation({ client, sessionId }: { client: BrowserAgentClient; sessionId: string }) {
  const items = useAgentAtomValue(itemsAtom)
  const run = useAgentAtomValue(runAtom)
  const events = useAgentAtomValue(runtimeTranscriptEventsAtom)
  const cards = useAgentAtomValue(browserCardsAtom)
  const answers = useAgentAtomValue(pendingQuestionAnswersAtom)
  const undo = useAgentAtomValue(client.core.sessionUndoAvailabilityAtom(sessionId))
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState('')
  const recovery = client.core.getSessionRecoveryStatus(sessionId)
  const busy = Boolean(run && ['running', 'awaiting_tool', 'waiting_confirmation', 'waiting_user', 'waiting_plan_approval'].includes(run.status))
  async function send(event: FormEvent) {
    event.preventDefault(); const text = draft.trim(); if (!text) return
    setFeedback('')
    try { await client.core.sendMessage({ text }, { sessionId }); setDraft('') }
    catch (error) { setFeedback(errorText(error)) }
  }
  function history(direction: 'undo' | 'redo') {
    const result = direction === 'undo' ? client.core.undoTurn(sessionId) : client.core.redoTurn(sessionId)
    setFeedback(result.ok ? `${direction === 'undo' ? '撤销' : '重做'}完成。` : refusalText(result.refusal))
  }
  function recover() {
    const result = client.core.continueRecoveredSession(sessionId)
    setFeedback(result.status === 'continued' ? '已继续恢复的运行。' : recoveryText(result.status))
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }
  return <section className="bav-chat" aria-label="当前会话">
    <ConversationTimeline items={items} runtimeEvents={events} browserCards={cards} />
    <div className="bav-run-strip"><span className={`bav-run-dot ${run?.status ?? 'idle'}`} /><span>{statusText(run?.status)}</span>{run?.error && <span className="bav-error">{run.error}</span>}</div>
    <DecisionCards client={client} sessionId={sessionId} run={run} answers={answers} />
    {recovery.status === 'recoverable' && <div className="bav-recovery"><div><strong>可恢复上次运行</strong><span>将从持久化的安全断点继续。</span></div><button type="button" onClick={recover}>恢复运行</button></div>}
    {recovery.status === 'reconciliation_required' && <div className="bav-recovery is-blocked"><strong>恢复需要人工核对</strong><span>工具结果尚不明确，系统不会自动重放可能影响网页或业务系统的操作。</span></div>}
    {feedback && <p role="status" className="bav-feedback">{feedback}</p>}
    <div className="bav-history-actions"><button type="button" className="bav-secondary" disabled={!undo.canUndo} onClick={() => history('undo')}>撤销</button><button type="button" className="bav-secondary" disabled={!undo.canRedo} onClick={() => history('redo')}>重做</button>{busy && <button type="button" className="bav-danger" onClick={() => client.core.stopRun({ sessionId })}>停止</button>}<span>{undo.blocked === 'irreversible_barrier' ? '撤销已被不可逆操作边界阻止。' : undo.willStopRun ? '撤销会先停止当前运行。' : ''}</span></div>
    <p className="bav-boundary">撤销只影响对话状态，不能撤销已在网页或业务系统执行的操作。</p>
    <form className="bav-composer" onSubmit={send}><textarea aria-label="消息" placeholder="输入消息；Enter 发送，Shift+Enter 换行" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} disabled={busy} /><button disabled={busy || !draft.trim()}>发送</button></form>
  </section>
}

function statusText(status?: string): string { return ({ idle: '空闲', running: '正在思考', awaiting_tool: '工具执行中', waiting_confirmation: '等待确认', waiting_user: '等待你的答复', waiting_plan_approval: '等待计划批准', interrupted: '运行已中断', done: '已完成', stopped: '已取消', error: '运行出错' } as Record<string, string>)[status ?? 'idle'] ?? status ?? '空闲' }
function refusalText(value?: string): string { return ({ nothing_to_apply: '没有可撤销或重做的内容。', irreversible_barrier: '无法越过外部操作的不可逆边界。', no_session: '会话已不可用。', turn_not_retractable: '这轮对话不能撤回。' } as Record<string, string>)[value ?? ''] ?? '操作未生效。' }
function recoveryText(status: string): string { return status === 'reconciliation_required' ? '恢复前需要核对工具结果。' : status === 'awaiting_user' ? '请先完成当前决策。' : '当前状态无法恢复。' }
function errorText(value: unknown): string { return value instanceof Error ? value.message : '发送失败，请重试' }
