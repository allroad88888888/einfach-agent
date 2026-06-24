import { useAtomValue } from '@einfach/react'
import { activeRunAtom, activeTimelineAtom } from '../agent/state/atoms'
import type { TimelineEvent, TimelineKind, TimelineStatus } from '../agent/runtime/types'

const visibleStatuses = new Set(['running', 'waiting_user'])

export function RunActivity() {
  const run = useAtomValue(activeRunAtom)
  const timeline = useAtomValue(activeTimelineAtom)

  if (!run || !visibleStatuses.has(run.status)) return null

  const maxVisibleEvents = run.status === 'waiting_user' ? 3 : 4
  const events = timeline.filter((event) => event.runId === run.id).slice(-maxVisibleEvents)
  if (events.length === 0) return null

  const runningEvent = [...events].reverse().find((event) => event.status === 'running')

  return (
    <section
      className={`run-activity run-activity--${run.status}`}
      aria-labelledby="run-activity-title"
      aria-live="polite"
    >
      <div className="run-activity-header">
        <div className="run-activity-title-block">
          <span className="run-activity-eyebrow">
            {run.status === 'waiting_user' ? '已暂停' : '实时'}
          </span>
          <h2 id="run-activity-title">{run.status === 'waiting_user' ? '等待用户确认' : '执行中'}</h2>
        </div>
        <div className="run-activity-summary">
          {runningEvent && <span className="run-activity-current">{formatKind(runningEvent.kind)}</span>}
          <span className="run-activity-count">{events.length} 步</span>
        </div>
      </div>
      <ol className="run-activity-list" aria-label="当前运行轨迹">
        {events.map((event) => (
          <li
            key={event.id}
            className={`run-activity-item run-activity-item--${event.kind} run-activity-item--${event.status}`}
          >
            <span className="run-activity-dot" aria-hidden="true" />
            <div className="run-activity-content">
              <div className="run-activity-line">
                <span className={`run-activity-kind run-activity-kind--${event.kind}`}>
                  {formatKind(event.kind)}
                </span>
                <strong>{event.title}</strong>
                <span className={`run-activity-state run-activity-state--${event.status}`}>
                  {formatStatus(event.status)}
                </span>
              </div>
              {event.detail && <p>{formatDetail(event)}</p>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function formatKind(kind: TimelineKind) {
  const labels: Record<TimelineKind, string> = {
    agent: '智能体',
    skill: '技能',
    tool: '工具',
    question: '提问',
    model: '思考',
    system: '系统',
  }
  return labels[kind]
}

function formatStatus(status: TimelineStatus) {
  const labels: Record<TimelineStatus, string> = {
    pending: '等待',
    running: '进行中',
    done: '完成',
    error: '异常',
    stopped: '停止',
  }
  return labels[status]
}

function formatDetail(event: TimelineEvent) {
  if (event.kind === 'model' && event.detail?.startsWith('思考：')) return event.detail
  if (event.kind === 'model' && event.detail?.startsWith('工具调用：')) return event.detail
  return event.detail
}
