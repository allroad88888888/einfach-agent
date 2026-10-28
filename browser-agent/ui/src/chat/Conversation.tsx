import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useAgentAtomValue } from '@einfach-agent/react-plugin'
import { browserCardsAtom, itemsAtom, pendingQuestionAnswersAtom, runAtom, runtimeTranscriptEventsAtom } from '@einfach-agent/core'
import { restoreTextAttachmentDraft, type TextAttachment, type BrowserAgentClient } from '@einfach-agent/browser-agent'
import { ConversationTimeline } from './ConversationTimeline'
import { DecisionCards } from './DecisionCards'
import { Composer } from './Composer'

export function Conversation({ client, sessionId, draft, setDraft, files, setFiles, submitting, setSubmitting, blocked }: { client: BrowserAgentClient; sessionId: string; draft: string; submitting: boolean; setSubmitting(value: boolean): void; files: TextAttachment[]; setFiles(files: TextAttachment[]): void; setDraft(value: string): void; blocked?: string }) {
  const items = useAgentAtomValue(itemsAtom)
  const run = useAgentAtomValue(runAtom)
  const events = useAgentAtomValue(runtimeTranscriptEventsAtom)
  const cards = useAgentAtomValue(browserCardsAtom)
  const answers = useAgentAtomValue(pendingQuestionAnswersAtom)
  const turnHistory = useAgentAtomValue(client.core.sessionTurnHistoryAtom(sessionId))
  const [feedback, setFeedback] = useState('')
  const sending = useRef(false)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const focusWhenReady = useRef(false)
  const recovery = client.core.getSessionRecoveryStatus(sessionId)
  const busy = Boolean(run && ['running', 'awaiting_tool', 'waiting_confirmation', 'waiting_user', 'waiting_plan_approval'].includes(run.status))
  async function send(event: FormEvent) {
    event.preventDefault()
    if ((!draft.trim() && !files.length) || busy || submitting || blocked || sending.current) return
    sending.current = true
    setSubmitting(true)
    setFeedback('')
    try {
      const result = await client.core.sendMessage({ text: draft, files }, { sessionId })
      if (result.accepted) { setDraft(''); setFiles([]) }
      else setFeedback(result.error ?? '消息未发送，请检查会话状态后重试。')
    } catch (error) { setFeedback(errorText(error)) }
    finally { sending.current = false; setSubmitting(false) }
  }

  function retract(userItemId: string) {
    const turn = turnHistory.turns.find((candidate) => candidate.userItem.id === userItemId)
    const result = client.core.retractTurn(userItemId, sessionId)
    if (result.ok && turn) {
      if (turn.userItem.item.role === 'user') {
        const restored = restoreTextAttachmentDraft(turn.userItem.item.content)
        setDraft(restored.text); setFiles(restored.files)
      }
      focusWhenReady.current = true
    }
    setFeedback(result.ok ? `已撤销此消息及后续对话。${result.stoppedRun ? ' 当前运行已停止。' : ''}` : refusalText(result.refusal))
  }
  function recover() {
    const result = client.core.continueRecoveredSession(sessionId)
    setFeedback(result.status === 'continued' ? '已继续恢复的运行。' : recoveryText(result.status))
  }
  useEffect(() => {
    if (!busy && !submitting && focusWhenReady.current) {
      focusWhenReady.current = false
      composerRef.current?.focus()
    }
  })
  return <section className="bav-chat" aria-label="当前会话">
    <ConversationTimeline items={items} runtimeEvents={events} browserCards={cards} turnHistory={turnHistory} onRetract={retract} />
    <div className="bav-chat-activity">
      {(busy || run?.error) && <div className="bav-run-strip"><span className={`bav-run-dot ${run?.status ?? 'idle'}`} /><span>{statusText(run?.status)}</span>{run?.error && <span className="bav-error">{run.error}</span>}{busy && <button type="button" className="bav-danger" onClick={() => client.core.stopRun({ sessionId })}>停止</button>}</div>}
      <fieldset className="bav-decision-guard" disabled={Boolean(blocked)}><DecisionCards client={client} sessionId={sessionId} run={run} answers={answers} /></fieldset>
      {recovery.status === 'recoverable' && <div className="bav-recovery"><div><strong>可恢复上次运行</strong><span>将从持久化的安全断点继续。</span></div><button type="button" disabled={Boolean(blocked)} onClick={recover}>恢复运行</button></div>}
      {recovery.status === 'reconciliation_required' && <div className="bav-recovery is-blocked"><strong>恢复需要人工核对</strong><span>工具结果尚不明确，系统不会自动重放可能影响网页或业务系统的操作。</span></div>}
      {blocked && <p role="status" className="bav-feedback">{blocked}</p>}
      {feedback && <p role="status" className="bav-feedback">{feedback}</p>}
    </div>
    <Composer draft={draft} files={files} disabled={busy || submitting} blocked={Boolean(blocked)} submitting={submitting} textareaRef={composerRef} onDraft={setDraft} onFiles={setFiles} onError={setFeedback} onSubmit={send} />
  </section>
}

function statusText(status?: string): string { return ({ idle: '空闲', running: '正在思考', awaiting_tool: '工具执行中', waiting_confirmation: '等待确认', waiting_user: '等待你的答复', waiting_plan_approval: '等待计划批准', interrupted: '运行已中断', done: '已完成', stopped: '已取消', error: '运行出错' } as Record<string, string>)[status ?? 'idle'] ?? status ?? '空闲' }
function refusalText(value?: string): string { return ({ nothing_to_apply: '没有可撤销的内容。', irreversible_barrier: '无法越过外部操作的不可逆边界。', no_session: '会话已不可用。', turn_not_retractable: '这轮对话不能撤回。' } as Record<string, string>)[value ?? ''] ?? '操作未生效。' }
function recoveryText(status: string): string { return status === 'reconciliation_required' ? '恢复前需要核对工具结果。' : status === 'awaiting_user' ? '请先完成当前决策。' : '当前状态无法恢复。' }
function errorText(value: unknown): string { return value instanceof Error ? value.message : '发送失败，请重试' }
