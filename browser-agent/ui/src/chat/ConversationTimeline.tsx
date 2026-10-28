import { projectTimelineItems, type TimelineItem } from '@einfach-agent/core/timeline'
import type { BrowserCard, ConversationItem, SessionTurnHistoryItem, SessionTurnHistoryProjection } from '@einfach-agent/core'
import { MessageContent } from './MessageContent'

interface ConversationTimelineProps {
  items: readonly ConversationItem[]
  runtimeEvents: Parameters<typeof projectTimelineItems>[0]['runtimeEvents']
  browserCards: readonly BrowserCard[]
  turnHistory?: SessionTurnHistoryProjection
  onRetract?(userItemId: string): void
}

export function ConversationTimeline({ items, runtimeEvents, browserCards, turnHistory, onRetract }: ConversationTimelineProps) {
  const timeline = projectTimelineItems({ conversationItems: items, runtimeEvents, browserCards })
  const byId = new Map(turnHistory?.turns.map((turn) => [turn.userItem.id, turn]))
  return <div className="bav-messages" aria-label="消息记录" aria-live="polite">{timeline.length ? groupedEntries(timeline, byId, onRetract) : <div className="bav-empty-state"><strong>准备好了</strong><span>发送第一条消息开始工作。</span></div>}</div>
}

function groupedEntries(timeline: readonly TimelineItem[], turns: ReadonlyMap<string, SessionTurnHistoryItem>, onRetract?: (userItemId: string) => void) {
  const entries = []
  for (let index = 0; index < timeline.length;) {
    const item = timeline[index]
    if (item.kind !== 'runtime-event') { entries.push(<TimelineEntry item={item} turn={item.kind === 'message' || item.kind === 'thinking-message' ? turns.get(item.conversationItem.id) : undefined} onRetract={onRetract} key={item.id} />); index++; continue }
    const events: Extract<TimelineItem, { kind: 'runtime-event' }>[] = []
    while (timeline[index]?.kind === 'runtime-event') events.push(timeline[index++] as Extract<TimelineItem, { kind: 'runtime-event' }>)
    entries.push(<details className="bav-runtime-details" key={events[0].id}><summary>运行详情 <span>{events.length}</span></summary>{events.map(({ event }) => <div key={event.id}><strong>{event.title}</strong>{event.summary && <span>{event.summary}</span>}{event.detail && <pre>{event.detail}</pre>}</div>)}</details>)
  }
  return entries
}

function TimelineEntry({ item, turn, onRetract }: { item: TimelineItem; turn?: SessionTurnHistoryItem; onRetract?: (userItemId: string) => void }) {
  if (item.kind === 'message' || item.kind === 'thinking-message') {
    const role = item.conversationItem.item.role
    const content = 'content' in item.conversationItem.item ? item.conversationItem.item.content : ''
    return <article className={`bav-message ${role} ${item.kind === 'thinking-message' ? 'thinking' : ''}`}><b>{role === 'user' ? '你' : 'Agent'}</b><MessageContent content={content} />{role === 'user' && turn && <MessageHistoryButton turn={turn} onActivate={onRetract} />}</article>
  }
  if (item.kind === 'reasoning') return <details className="bav-thinking"><summary>思考过程</summary><p>{item.content}</p></details>
  if (item.kind === 'tool-execution-group') return <section className="bav-tool-group" aria-label="工具执行">{item.executions.map((execution, index) => <div key={execution.call?.id ?? execution.result?.tool_call_id ?? index}><div><strong>{execution.call?.function.name ?? execution.toolName ?? '工具'}</strong><span>{execution.result ? toolFailed(execution.result.content) ? '失败' : '已完成' : '执行中'}</span></div>{(execution.call || execution.result) && <details><summary>参数与结果</summary>{execution.call && <pre>{execution.call.function.arguments}</pre>}{execution.result && <pre>{typeof execution.result.content === 'string' ? execution.result.content : JSON.stringify(execution.result.content)}</pre>}</details>}</div>)}</section>
  if (item.kind === 'runtime-event') return <details className="bav-runtime-details"><summary>运行详情 <span>1</span></summary><div><strong>{item.event.title}</strong>{item.event.summary && <span>{item.event.summary}</span>}{item.event.detail && <pre>{item.event.detail}</pre>}</div></details>
  return <article className="bav-card"><strong>{item.card.title ?? '网页结果'}</strong><pre>{JSON.stringify(item.card, null, 2)}</pre></article>
}

function MessageHistoryButton({ turn, onActivate }: { turn: SessionTurnHistoryItem; onActivate?: (userItemId: string) => void }) {
  const boundary = '只影响对话状态，不能撤销已在网页或业务系统执行的操作。'
  const reason = turn.blocked === 'irreversible_barrier' ? '外部操作形成不可逆边界，无法撤销此消息。' : turn.blocked === 'history_unavailable' ? '此消息缺少可验证的撤销记录（旧版本已淘汰或日志损坏）。' : `撤销此消息及后续对话。${turn.willStopRun ? '当前运行会先停止。' : ''}${boundary}`
  const reasonId = `bav-history-reason-${turn.userItem.id}`
  const activate = () => { if (!turn.blocked) onActivate?.(turn.userItem.id) }
  return <span className="bav-message-history-control"><button type="button" className="bav-message-history-button" aria-label={reason} aria-describedby={turn.blocked ? reasonId : undefined} aria-disabled={Boolean(turn.blocked)} title={reason} onClick={activate}><UndoIcon /><span>撤销</span></button>{turn.blocked && <span id={reasonId} className="bav-message-history-reason">{reason}</span>}</span>
}

function UndoIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 7 4 12l5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/></svg> }

function toolFailed(content: unknown): boolean { return typeof content === 'string' && /error|failed|失败/i.test(content) }
