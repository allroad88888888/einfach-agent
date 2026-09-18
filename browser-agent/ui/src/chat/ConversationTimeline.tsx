import { projectTimelineItems, type TimelineItem } from '@einfach-agent/core/timeline'
import type { BrowserCard, ConversationItem } from '@einfach-agent/core'

export function ConversationTimeline({ items, runtimeEvents, browserCards }: { items: readonly ConversationItem[]; runtimeEvents: Parameters<typeof projectTimelineItems>[0]['runtimeEvents']; browserCards: readonly BrowserCard[] }) {
  const timeline = projectTimelineItems({ conversationItems: items, runtimeEvents, browserCards })
  return <div className="bav-messages" aria-label="消息记录" aria-live="polite">{timeline.length ? timeline.map((item) => <TimelineEntry item={item} key={item.id} />) : <div className="bav-empty-state"><strong>准备好了</strong><span>发送第一条消息开始工作。</span></div>}</div>
}

function TimelineEntry({ item }: { item: TimelineItem }) {
  if (item.kind === 'message' || item.kind === 'thinking-message') {
    const role = item.conversationItem.item.role
    const content = 'content' in item.conversationItem.item ? item.conversationItem.item.content : ''
    return <article className={`bav-message ${role} ${item.kind === 'thinking-message' ? 'thinking' : ''}`}><b>{role === 'user' ? '你' : 'Agent'}</b><p>{typeof content === 'string' ? content : JSON.stringify(content)}</p></article>
  }
  if (item.kind === 'reasoning') return <details className="bav-thinking"><summary>思考过程</summary><p>{item.content}</p></details>
  if (item.kind === 'tool-execution-group') return <section className="bav-tool-group" aria-label="工具执行">{item.executions.map((execution, index) => <div key={execution.call?.id ?? execution.result?.tool_call_id ?? index}><div><strong>{execution.call?.function.name ?? execution.toolName ?? '工具'}</strong><span>{execution.result ? toolFailed(execution.result.content) ? '失败' : '已完成' : '执行中'}</span></div>{execution.call && <pre>{execution.call.function.arguments}</pre>}{execution.result && <pre>{typeof execution.result.content === 'string' ? execution.result.content : JSON.stringify(execution.result.content)}</pre>}</div>)}</section>
  if (item.kind === 'runtime-event') return <div className="bav-runtime-event"><strong>运行事件</strong><span>{item.event.kind}</span></div>
  return <article className="bav-card"><strong>{item.card.title ?? '网页结果'}</strong><pre>{JSON.stringify(item.card, null, 2)}</pre></article>
}

function toolFailed(content: unknown): boolean { return typeof content === 'string' && /error|failed|失败/i.test(content) }
