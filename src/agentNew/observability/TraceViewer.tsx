import { useEffect, type CSSProperties } from 'react'
import { useAtomValue, useSetAtom } from '@einfach/react'
import {
  activeTraceRunAtom,
  refreshTraceLogsAtom,
  selectTraceEntryAtom,
  selectTraceRunAtom,
  selectedTraceEntryAtom,
  traceFiltersAtom,
  traceLoadStateAtom,
  traceViewAtom,
  updateTraceFiltersAtom,
} from './traceViewerState'
import type { TraceFilters, TraceTimelineEntry } from './traceViewModel'

const LEVEL_OPTIONS: Array<{ value: TraceFilters['level']; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'error', label: 'error' },
  { value: 'cancelled', label: 'cancelled' },
  { value: 'running', label: 'running' },
  { value: 'ok', label: 'ok' },
]

const TYPE_OPTIONS: Array<{ value: TraceFilters['type']; label: string }> = [
  { value: 'all', label: '全部类型' },
  { value: 'agent', label: 'agent' },
  { value: 'llm', label: 'llm' },
  { value: 'tool', label: 'tool' },
  { value: 'internal', label: 'internal' },
  { value: 'event', label: 'event' },
]

function sourceLabel(source: string | undefined): string {
  if (source === 'sqlite') return 'SQLite'
  if (source === 'indexeddb') return 'IndexedDB'
  return '未读取'
}

function formatTime(value: number | undefined): string {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return '-'
  if (value < 1000) return `${Math.round(value)}ms`
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)}s`
}

function statusClass(value: string): string {
  return `trace-chip trace-chip--${value}`
}

function jsonText(value: unknown): string {
  if (value === undefined) return '{}'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export interface TracePreviewRow {
  key: string
  label: string
  value: string
}

const PREVIEW_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'requestPreview', label: 'request' },
  { key: 'responsePreview', label: 'response' },
  { key: 'argsPreview', label: 'args' },
  { key: 'resultPreview', label: 'result' },
  { key: 'errorPreview', label: 'error' },
  { key: 'validationError', label: 'validation' },
]

function previewValueText(value: unknown): string {
  return typeof value === 'string' ? value : jsonText(value)
}

export function tracePreviewRows(attrs: Record<string, unknown> | undefined): TracePreviewRow[] {
  if (!attrs) return []
  return PREVIEW_FIELDS.flatMap((field) => {
    const value = attrs[field.key]
    if (value === undefined || value === null || value === '') return []
    return [{ key: field.key, label: field.label, value: previewValueText(value) }]
  })
}

function highlightTitle(entry: { reason: string; detail?: string }): string {
  return entry.detail ? `${entry.reason}: ${entry.detail}` : entry.reason
}

function TraceHeader() {
  const filters = useAtomValue(traceFiltersAtom)
  const loadState = useAtomValue(traceLoadStateAtom)
  const view = useAtomValue(traceViewAtom)
  const refresh = useSetAtom(refreshTraceLogsAtom)
  const updateFilters = useSetAtom(updateTraceFiltersAtom)
  const loading = loadState.status === 'loading'
  const source = loadState.status === 'ready' || loadState.status === 'error' ? loadState.source : undefined
  const loadedAt = loadState.status === 'ready' || loadState.status === 'error' ? loadState.loadedAt : undefined

  return (
    <header className="trace-header">
      <div className="trace-title">
        <h1>Observability Logs</h1>
        <div className="trace-subtitle">
          {sourceLabel(source)} · runs {view.filteredRuns}/{view.totalRuns} · spans {view.totalSpans} · events {view.totalEvents}
        </div>
      </div>
      <div className="trace-controls" aria-label="日志过滤">
        <select
          value={filters.level}
          aria-label="状态过滤"
          onChange={(event) => updateFilters({ level: event.target.value as TraceFilters['level'] })}
        >
          {LEVEL_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          value={filters.type}
          aria-label="类型过滤"
          onChange={(event) => updateFilters({ type: event.target.value as TraceFilters['type'] })}
        >
          {TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          value={filters.search}
          aria-label="搜索日志"
          placeholder="search name/id/attrs"
          onChange={(event) => updateFilters({ search: event.target.value })}
        />
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? '读取中' : '刷新'}
        </button>
      </div>
      <div className="trace-meta">
        <span>last loaded {formatTime(loadedAt)}</span>
      </div>
      {loadState.status === 'error' ? (
        <div className="trace-error" role="alert">
          {loadState.error}
        </div>
      ) : null}
    </header>
  )
}

function TraceRunList() {
  const view = useAtomValue(traceViewAtom)
  const activeRun = useAtomValue(activeTraceRunAtom)
  const selectRun = useSetAtom(selectTraceRunAtom)

  return (
    <aside className="trace-runs" aria-label="run 列表">
      <div className="trace-pane-title">Runs</div>
      {view.runs.length === 0 ? (
        <div className="trace-empty">没有匹配的 run</div>
      ) : (
        <div className="trace-run-list">
          {view.runs.map((run) => (
            <button
              key={run.id}
              type="button"
              className={`trace-run-item${activeRun?.id === run.id ? ' active' : ''}${run.highlight ? ' trace-run-item--highlight' : ''}`}
              onClick={() => selectRun(run.id)}
            >
              <span className="trace-run-main">
                <span className="trace-run-title">{run.title}</span>
                <span className="trace-run-time">{formatTime(run.startedAt)}</span>
              </span>
              <span className="trace-run-stats">
                <span className={statusClass(run.status)}>{run.status}</span>
                {run.highlight ? (
                  <span className="trace-highlight-chip" title={highlightTitle(run.highlight)}>
                    {run.highlight.label}
                  </span>
                ) : null}
                <span>{formatDuration(run.durationMs)}</span>
                <span>{run.spanCount} spans</span>
                <span>{run.eventCount} events</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </aside>
  )
}

function TraceTimeline() {
  const run = useAtomValue(activeTraceRunAtom)
  const selected = useAtomValue(selectedTraceEntryAtom)
  const selectEntry = useSetAtom(selectTraceEntryAtom)

  return (
    <section className="trace-timeline" aria-label="span timeline">
      <div className="trace-pane-title">
        Timeline
        {run ? <span>{run.title}</span> : null}
      </div>
      {!run ? (
        <div className="trace-empty">选择一个 run 查看时间线</div>
      ) : (
        <div className="trace-entry-list">
          {run.timeline.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`trace-entry trace-entry--${entry.entryType}${selected?.id === entry.id ? ' active' : ''}${entry.highlight ? ' trace-entry--highlight' : ''}`}
              style={{ '--trace-depth': Math.min(entry.depth, 8) } as CSSProperties}
              onClick={() => selectEntry(entry.id)}
            >
              <span className="trace-entry-time">{formatTime(entry.timestamp)}</span>
              <span className={statusClass(entry.level)}>{entry.level}</span>
              <span className="trace-entry-type">{entry.type}</span>
              <span className="trace-entry-name">
                {entry.name}
                {entry.highlight ? (
                  <span className="trace-entry-reason" title={highlightTitle(entry.highlight)}>
                    {entry.highlight.label}
                  </span>
                ) : null}
              </span>
              <span className="trace-entry-duration">
                {entry.entryType === 'span' ? formatDuration(entry.durationMs) : ''}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function TraceDetail() {
  const entry = useAtomValue(selectedTraceEntryAtom)

  return (
    <aside className="trace-detail" aria-label="选中 span 明细">
      <div className="trace-pane-title">Details</div>
      {!entry ? (
        <div className="trace-empty">没有选中记录</div>
      ) : (
        <div className="trace-detail-body">
          <div className="trace-detail-head">
            <span className={statusClass(entry.level)}>{entry.level}</span>
            <strong>{entry.name}</strong>
            {entry.highlight ? (
              <span className="trace-highlight-chip" title={highlightTitle(entry.highlight)}>
                {entry.highlight.label}
              </span>
            ) : null}
          </div>
          <dl className="trace-detail-grid">
            <dt>id</dt>
            <dd>{entry.entryType === 'span' ? entry.span.id : entry.event.id}</dd>
            <dt>trace</dt>
            <dd>{entry.traceId}</dd>
            <dt>type</dt>
            <dd>{entry.type}</dd>
            <dt>time</dt>
            <dd>{formatTime(entry.timestamp)}</dd>
            {entry.entryType === 'span' ? (
              <>
                <dt>parent</dt>
                <dd>{entry.span.parentSpanId ?? '-'}</dd>
                <dt>duration</dt>
                <dd>{formatDuration(entry.durationMs)}</dd>
                <dt>error</dt>
                <dd>{entry.span.error ?? '-'}</dd>
              </>
            ) : (
              <>
                <dt>span</dt>
                <dd>{entry.event.spanId ?? '-'}</dd>
              </>
            )}
          </dl>
          <TracePayload entry={entry} />
        </div>
      )}
    </aside>
  )
}

function TracePayload({ entry }: { entry: TraceTimelineEntry }) {
  const payload = entry.entryType === 'span' ? entry.span.attrs : entry.event.attrs
  const previews = tracePreviewRows(payload)
  return (
    <>
      {previews.length > 0 ? (
        <div className="trace-previews">
          <div className="trace-payload-title">previews</div>
          {previews.map((preview) => (
            <div className="trace-preview" key={preview.key}>
              <div className="trace-preview-label">{preview.label}</div>
              <pre>{preview.value}</pre>
            </div>
          ))}
        </div>
      ) : null}
      <div className="trace-payload">
        <div className="trace-payload-title">attrs</div>
        <pre>{jsonText(payload)}</pre>
      </div>
    </>
  )
}

export function TraceViewer() {
  const refresh = useSetAtom(refreshTraceLogsAtom)

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="trace-viewer">
      <TraceHeader />
      <div className="trace-body">
        <TraceRunList />
        <TraceTimeline />
        <TraceDetail />
      </div>
    </div>
  )
}
