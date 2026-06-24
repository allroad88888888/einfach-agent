import { useAtomValue } from '@einfach/react'
import { activeTimelineAtom } from '../agent/state/atoms'
import type { TimelineKind, TimelineStatus } from '../agent/runtime/types'

const kindLabels: Record<TimelineKind, string> = {
  agent: '智能体',
  skill: '技能',
  tool: '工具',
  question: '提问',
  model: '思考',
  system: '系统',
}

const statusLabels: Record<TimelineStatus, string> = {
  pending: '等待',
  running: '进行中',
  done: '完成',
  error: '异常',
  stopped: '停止',
}

export function ToolTimeline() {
  const timeline = useAtomValue(activeTimelineAtom)
  const runningCount = timeline.filter(
    (event) => event.status === 'running' || event.status === 'pending',
  ).length
  const issueCount = timeline.filter((event) => event.status === 'error' || event.status === 'stopped')
    .length

  return (
    <aside className="timeline-pane timeline-pane--run-inspector" aria-labelledby="tool-timeline-title">
      <header className="timeline-header timeline-header--inspector">
        <div className="timeline-event-top timeline-inspector-toolbar">
          <div className="timeline-title-block">
            <div className="timeline-eyebrow">运行追踪</div>
            <h2 id="tool-timeline-title">运行过程</h2>
          </div>
          <div className="timeline-inspector-summary" aria-label={`共 ${timeline.length} 个事件`}>
            <span className="timeline-status timeline-status--total">{timeline.length} 个事件</span>
            {runningCount > 0 && (
              <span className="timeline-status timeline-status--active">{runningCount} 进行中</span>
            )}
            {issueCount > 0 && (
              <span className="timeline-status timeline-status--issue">{issueCount} 异常</span>
            )}
          </div>
        </div>
      </header>
      <div className="timeline-list timeline-list--inspector" role="list" aria-label="运行事件">
        {timeline.length === 0 && (
          <div className="timeline-empty timeline-empty--inspector" role="status">
            暂无事件
          </div>
        )}
        {timeline.map((event, index) => (
          <article
            key={event.id}
            className={`timeline-event timeline-${event.status} timeline-event--${event.kind} timeline-event--${event.status}`}
            role="listitem"
            data-event-id={event.id}
            data-run-id={event.runId}
          >
            <div className="timeline-event-top timeline-event-top--inspector">
              <div className="timeline-event-tags">
                <span className={`timeline-kind kind-${event.kind} timeline-kind--${event.kind}`}>
                  {kindLabels[event.kind]}
                </span>
                {event.actor && <span className="timeline-kind timeline-actor">{event.actor}</span>}
              </div>
              <span className="timeline-status">{statusLabels[event.status]}</span>
            </div>
            <div className="timeline-event-body">
              <div className="timeline-event-meta" aria-label={`事件 ${index + 1}`}>
                <span className="timeline-event-index">#{index + 1}</span>
                <span className="timeline-event-run">{event.runId}</span>
              </div>
              <h3>{event.title}</h3>
              {event.detail && <p className="timeline-event-detail">{event.detail}</p>}
            </div>
          </article>
        ))}
      </div>
    </aside>
  )
}
