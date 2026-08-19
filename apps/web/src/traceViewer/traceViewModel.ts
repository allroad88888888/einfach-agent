import type {
  TraceEvent,
  TraceSpan,
  TraceStatus,
  SpanKind,
  TraceLogSnapshot,
} from '@einfach-agent/core/observability'

export type TraceLevelFilter = 'all' | TraceStatus
export type TraceTypeFilter = 'all' | SpanKind | 'event'

export interface TraceFilters {
  level: TraceLevelFilter
  type: TraceTypeFilter
  search: string
}

export type TraceHighlightReason =
  | 'agent.max_turns'
  | 'agent.loop_detected'
  | 'tool.validation_failed'
  | 'tool.call_error'

export interface TraceHighlight {
  reason: TraceHighlightReason
  label: string
  detail?: string
}

export interface TraceSpanEntry {
  id: string
  entryType: 'span'
  traceId: string
  timestamp: number
  level: TraceStatus
  type: SpanKind
  name: string
  durationMs?: number
  depth: number
  highlight?: TraceHighlight
  span: TraceSpan
}

export interface TraceEventEntry {
  id: string
  entryType: 'event'
  traceId: string
  timestamp: number
  level: 'event'
  type: 'event'
  name: string
  depth: number
  highlight?: TraceHighlight
  event: TraceEvent
}

export type TraceTimelineEntry = TraceSpanEntry | TraceEventEntry

export interface TraceRunSummary {
  id: string
  title: string
  traceId: string
  sessionId?: string
  runId?: string
  turnId?: string
  status: TraceStatus
  startedAt: number
  endedAt?: number
  durationMs?: number
  vendor?: string
  model?: string
  spanCount: number
  eventCount: number
  llmCount: number
  toolCount: number
  archiveWriteAttempts: number
  archiveWriteFailures: number
  archiveWriteFailureRate?: number
  errorCount: number
  highlightCount: number
  highlight?: TraceHighlight
  totalTokens: number
  waitingState?: 'user' | 'confirmation'
  timeline: TraceTimelineEntry[]
}

export interface TraceViewModel {
  runs: TraceRunSummary[]
  totalRuns: number
  filteredRuns: number
  totalSpans: number
  totalEvents: number
}

export const DEFAULT_TRACE_FILTERS: TraceFilters = {
  level: 'all',
  type: 'all',
  search: '',
}

function attrText(attrs: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = attrs?.[key]
  return typeof value === 'string' && value ? value : undefined
}

function attrDisplayText(attrs: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = attrs?.[key]
  if (value === undefined || value === null || value === '') return undefined
  return typeof value === 'string' ? value : String(value)
}

function attrNumber(attrs: Record<string, unknown> | undefined, key: string): number {
  const value = attrs?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function highlightLabel(reason: TraceHighlightReason): string {
  if (reason === 'agent.max_turns') return 'max turns'
  if (reason === 'agent.loop_detected') return 'loop'
  if (reason === 'tool.validation_failed') return 'validation'
  return 'tool error'
}

function highlight(reason: TraceHighlightReason, detail?: string): TraceHighlight {
  return detail ? { reason, label: highlightLabel(reason), detail } : { reason, label: highlightLabel(reason) }
}

function highlightRank(item: TraceHighlight): number {
  if (item.reason === 'agent.loop_detected') return 4
  if (item.reason === 'agent.max_turns') return 3
  if (item.reason === 'tool.validation_failed') return 2
  return 1
}

function strongestHighlight(items: TraceHighlight[]): TraceHighlight | undefined {
  return items.reduce<TraceHighlight | undefined>((current, item) => {
    if (!current) return item
    return highlightRank(item) > highlightRank(current) ? item : current
  }, undefined)
}

function validationDetail(attrs: Record<string, unknown> | undefined): string | undefined {
  return (
    attrDisplayText(attrs, 'validationError') ??
    attrDisplayText(attrs, 'errorPreview') ??
    attrDisplayText(attrs, 'error')
  )
}

function eventHighlight(event: TraceEvent): TraceHighlight | undefined {
  if (event.name === 'agent.max_turns') {
    return highlight('agent.max_turns', attrDisplayText(event.attrs, 'error') ?? attrDisplayText(event.attrs, 'max_turns'))
  }
  if (event.name === 'agent.loop_detected') {
    return highlight('agent.loop_detected', attrDisplayText(event.attrs, 'reason') ?? attrDisplayText(event.attrs, 'error'))
  }
  if (event.name === 'tool.validation_failed') {
    return highlight('tool.validation_failed', validationDetail(event.attrs))
  }
  return undefined
}

function spanHighlight(span: TraceSpan): TraceHighlight | undefined {
  if (span.name === 'tool.validation_failed' || attrDisplayText(span.attrs, 'validationError')) {
    return highlight('tool.validation_failed', validationDetail(span.attrs) ?? span.error)
  }
  if (span.name === 'tool.call' && span.status === 'error') {
    return highlight(
      'tool.call_error',
      span.error ?? attrDisplayText(span.attrs, 'errorPreview') ?? attrDisplayText(span.attrs, 'error'),
    )
  }
  return undefined
}

function groupKey(record: TraceSpan | TraceEvent): string {
  const runId = attrText(record.attrs, 'runId')
  if (runId) return `run:${attrText(record.attrs, 'sessionId') ?? 'unknown'}:${runId}`
  return `trace:${record.traceId}`
}

function statusRank(status: TraceStatus): number {
  if (status === 'error') return 4
  if (status === 'cancelled') return 3
  if (status === 'running') return 2
  return 1
}

function strongestStatus(spans: TraceSpan[]): TraceStatus {
  return spans.reduce<TraceStatus>(
    (current, span) => (statusRank(span.status) > statusRank(current) ? span.status : current),
    'ok',
  )
}

function entryTimestamp(entry: TraceTimelineEntry): number {
  return entry.timestamp
}

function spanDepth(span: TraceSpan, spansById: Map<string, TraceSpan>): number {
  let depth = 0
  let parentId = span.parentSpanId
  const seen = new Set<string>()

  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = spansById.get(parentId)
    if (!parent) break
    depth += 1
    parentId = parent.parentSpanId
  }

  return depth
}

function eventDepth(event: TraceEvent, spansById: Map<string, TraceSpan>): number {
  const span = event.spanId ? spansById.get(event.spanId) : undefined
  return span ? spanDepth(span, spansById) + 1 : 0
}

function spanEntry(span: TraceSpan, spansById: Map<string, TraceSpan>): TraceSpanEntry {
  return {
    id: `span:${span.id}`,
    entryType: 'span',
    traceId: span.traceId,
    timestamp: span.startedAt,
    level: span.status,
    type: span.kind,
    name: span.name,
    durationMs: span.durationMs,
    depth: spanDepth(span, spansById),
    highlight: spanHighlight(span),
    span,
  }
}

function eventEntry(event: TraceEvent, spansById: Map<string, TraceSpan>): TraceEventEntry {
  return {
    id: `event:${event.id}`,
    entryType: 'event',
    traceId: event.traceId,
    timestamp: event.timestamp,
    level: 'event',
    type: 'event',
    name: event.name,
    depth: eventDepth(event, spansById),
    highlight: eventHighlight(event),
    event,
  }
}

function timelineText(entry: TraceTimelineEntry): string {
  const record = entry.entryType === 'span' ? entry.span : entry.event
  const attrs = record.attrs ? JSON.stringify(record.attrs) : ''
  const error = entry.entryType === 'span' ? entry.span.error : undefined
  const parentSpanId = entry.entryType === 'span' ? entry.span.parentSpanId : undefined
  const spanId = entry.entryType === 'event' ? entry.event.spanId : undefined

  return [
    entry.entryType,
    entry.name,
    entry.level,
    entry.type,
    entry.highlight?.reason,
    entry.highlight?.label,
    entry.highlight?.detail,
    entry.traceId,
    spanId,
    parentSpanId,
    error,
    attrs,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function runText(run: TraceRunSummary): string {
  return [
    run.id,
    run.title,
    run.traceId,
    run.sessionId,
    run.runId,
    run.turnId,
    run.status,
    run.highlight?.reason,
    run.highlight?.label,
    run.highlight?.detail,
    run.vendor,
    run.model,
    run.waitingState,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function traceTitle(rootSpan: TraceSpan | undefined, key: string): string {
  const runId = attrText(rootSpan?.attrs, 'runId')
  const turnId = attrText(rootSpan?.attrs, 'turnId')
  if (runId && turnId) return `${runId} / ${turnId}`
  if (runId) return runId
  return rootSpan?.traceId ?? key
}

function buildRuns(snapshot: TraceLogSnapshot | undefined): TraceRunSummary[] {
  if (!snapshot) return []

  const groups = new Map<string, { spans: TraceSpan[]; events: TraceEvent[] }>()

  for (const span of snapshot.spans) {
    const key = groupKey(span)
    const group = groups.get(key) ?? { spans: [], events: [] }
    group.spans.push(span)
    groups.set(key, group)
  }

  for (const event of snapshot.events) {
    const key = groupKey(event)
    const group = groups.get(key) ?? { spans: [], events: [] }
    group.events.push(event)
    groups.set(key, group)
  }

  return Array.from(groups.entries())
    .map(([key, group]): TraceRunSummary => {
      const spansById = new Map(group.spans.map((span) => [span.id, span]))
      const rootSpan =
        group.spans.find((span) => span.name === 'agent.turn') ??
        group.spans.find((span) => !span.parentSpanId) ??
        group.spans[0]
      const timeline = [...group.spans.map((span) => spanEntry(span, spansById)), ...group.events.map((event) => eventEntry(event, spansById))].sort(
        (a, b) => entryTimestamp(a) - entryTimestamp(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      )
      const startedAt = Math.min(...timeline.map(entryTimestamp))
      const endedAtCandidates = [
        ...group.spans.map((span) => span.endedAt).filter((value): value is number => typeof value === 'number'),
        ...group.events.map((event) => event.timestamp),
      ]
      const endedAt = endedAtCandidates.length > 0 ? Math.max(...endedAtCandidates) : undefined
      const status = rootSpan?.status ?? strongestStatus(group.spans)
      const waitingState = group.events.some((event) => event.name === 'agent.waiting_confirmation')
        ? 'confirmation'
        : group.events.some((event) => event.name === 'agent.waiting_user')
          ? 'user'
          : undefined
      const llmCount = group.spans.filter((span) => span.kind === 'llm' || span.name === 'llm.chat').length
      const toolCount = group.spans.filter((span) => span.kind === 'tool' || span.name === 'tool.call').length
      const archiveWriteSummaries = group.spans.filter((span) => span.name === 'subagent.archive_write_summary')
      const archiveWriteAttempts = archiveWriteSummaries.reduce(
        (sum, span) => sum + attrNumber(span.attrs, 'archive_write_attempts'),
        0,
      )
      const archiveWriteFailures = archiveWriteSummaries.reduce(
        (sum, span) => sum + attrNumber(span.attrs, 'archive_write_failures'),
        0,
      )
      const totalTokens = group.spans.reduce((sum, span) => sum + attrNumber(span.attrs, 'total_tokens'), 0)
      const timelineHighlights = timeline.map((entry) => entry.highlight).filter((item): item is TraceHighlight => item !== undefined)
      const errorCount = timeline.filter((entry) => {
        if (entry.entryType === 'span') return entry.span.status === 'error' || entry.highlight?.reason === 'tool.validation_failed'
        return attrText(entry.event.attrs, 'error') !== undefined || entry.highlight !== undefined
      }).length

      return {
        id: key,
        title: traceTitle(rootSpan, key),
        traceId: rootSpan?.traceId ?? timeline[0]?.traceId ?? key,
        sessionId: attrText(rootSpan?.attrs, 'sessionId') ?? attrText(group.events[0]?.attrs, 'sessionId'),
        runId: attrText(rootSpan?.attrs, 'runId') ?? attrText(group.events[0]?.attrs, 'runId'),
        turnId: attrText(rootSpan?.attrs, 'turnId') ?? attrText(group.events[0]?.attrs, 'turnId'),
        status,
        startedAt: Number.isFinite(startedAt) ? startedAt : 0,
        endedAt,
        durationMs: rootSpan?.durationMs ?? (endedAt !== undefined && Number.isFinite(startedAt) ? Math.max(0, endedAt - startedAt) : undefined),
        vendor: attrText(rootSpan?.attrs, 'vendor'),
        model: attrText(rootSpan?.attrs, 'model'),
        spanCount: group.spans.length,
        eventCount: group.events.length,
        llmCount,
        toolCount,
        archiveWriteAttempts,
        archiveWriteFailures,
        archiveWriteFailureRate: archiveWriteAttempts > 0 ? archiveWriteFailures / archiveWriteAttempts : undefined,
        errorCount,
        highlightCount: timelineHighlights.length,
        highlight: strongestHighlight(timelineHighlights),
        totalTokens,
        waitingState,
        timeline,
      }
    })
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
}

function normalizeLevel(level: unknown): TraceLevelFilter {
  if (level === 'ok' || level === 'running' || level === 'error' || level === 'cancelled') return level
  return 'all'
}

function normalizeType(type: unknown): TraceTypeFilter {
  if (type === 'agent' || type === 'llm' || type === 'tool' || type === 'internal' || type === 'event') return type
  return 'all'
}

export function normalizeTraceFilters(filters: Partial<TraceFilters>): TraceFilters {
  return {
    level: normalizeLevel(filters.level),
    type: normalizeType(filters.type),
    search: typeof filters.search === 'string' ? filters.search : '',
  }
}

function matchesLevel(entry: TraceTimelineEntry, level: TraceLevelFilter): boolean {
  if (level === 'all') return true
  return entry.entryType === 'span' && entry.level === level
}

function matchesType(entry: TraceTimelineEntry, type: TraceTypeFilter): boolean {
  if (type === 'all') return true
  return entry.type === type
}

function matchesSearch(entry: TraceTimelineEntry, search: string): boolean {
  return !search || timelineText(entry).includes(search)
}

function filterTimeline(timeline: TraceTimelineEntry[], filters: TraceFilters): TraceTimelineEntry[] {
  const search = filters.search.trim().toLowerCase()
  return timeline.filter(
    (entry) => matchesLevel(entry, filters.level) && matchesType(entry, filters.type) && matchesSearch(entry, search),
  )
}

function filterRuns(runs: TraceRunSummary[], filters: TraceFilters): TraceRunSummary[] {
  const search = filters.search.trim().toLowerCase()
  return runs
    .map((run) => ({ ...run, timeline: filterTimeline(run.timeline, filters) }))
    .filter((run) => {
      if (filters.level !== 'all' && run.status !== filters.level && run.timeline.length === 0) return false
      if (filters.type !== 'all' && run.timeline.length === 0) return false
      if (search && !runText(run).includes(search) && run.timeline.length === 0) return false
      return true
    })
}

export function buildTraceView(snapshot: TraceLogSnapshot | undefined, filters: TraceFilters = DEFAULT_TRACE_FILTERS): TraceViewModel {
  const normalizedFilters = normalizeTraceFilters(filters)
  const runs = buildRuns(snapshot)
  const filtered = filterRuns(runs, normalizedFilters)
  return {
    runs: filtered,
    totalRuns: runs.length,
    filteredRuns: filtered.length,
    totalSpans: snapshot?.spans.length ?? 0,
    totalEvents: snapshot?.events.length ?? 0,
  }
}

export function buildTraceViewModel(snapshot: TraceLogSnapshot | undefined): TraceViewModel {
  return buildTraceView(snapshot, DEFAULT_TRACE_FILTERS)
}

export function filterTraceTimeline(run: TraceRunSummary | undefined, filters: TraceFilters): TraceTimelineEntry[] {
  if (!run) return []
  return filterTimeline(run.timeline, normalizeTraceFilters(filters))
}

export function filterTraceRuns(runs: TraceRunSummary[], filters: TraceFilters): TraceRunSummary[] {
  return filterRuns(runs, normalizeTraceFilters(filters))
}
