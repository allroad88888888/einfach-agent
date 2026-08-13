import { atom } from '@einfach/core'
import { createTraceLogReader, type TraceLogSnapshot } from '@web-agent/core/observability/logReader'
import {
  buildTraceView,
  DEFAULT_TRACE_FILTERS,
  normalizeTraceFilters,
  type TraceFilters,
  type TraceRunSummary,
  type TraceTimelineEntry,
  type TraceViewModel,
} from './traceViewModel'

export type TraceLoadState =
  | { status: 'idle' }
  | { status: 'loading'; startedAt: number }
  | { status: 'ready'; source: TraceLogSnapshot['source']; loadedAt: number }
  | { status: 'error'; source?: TraceLogSnapshot['source']; loadedAt?: number; error: string }

const EMPTY_SNAPSHOT: TraceLogSnapshot = {
  source: 'indexeddb',
  loadedAt: 0,
  spans: [],
  events: [],
}

export const traceSnapshotAtom = atom<TraceLogSnapshot | undefined>(undefined)
export const traceLoadStateAtom = atom<TraceLoadState>({ status: 'idle' })
export const traceFiltersAtom = atom<TraceFilters>(DEFAULT_TRACE_FILTERS)
export const selectedTraceRunIdAtom = atom<string>('')
export const selectedTraceEntryIdAtom = atom<string>('')

export const traceViewAtom = atom((get): TraceViewModel => {
  return buildTraceView(get(traceSnapshotAtom) ?? EMPTY_SNAPSHOT, get(traceFiltersAtom))
})

export const activeTraceRunAtom = atom((get): TraceRunSummary | undefined => {
  const view = get(traceViewAtom)
  const selectedRunId = get(selectedTraceRunIdAtom)
  return view.runs.find((run) => run.id === selectedRunId) ?? view.runs[0]
})

export const selectedTraceEntryAtom = atom((get): TraceTimelineEntry | undefined => {
  const run = get(activeTraceRunAtom)
  const selectedEntryId = get(selectedTraceEntryIdAtom)
  return run?.timeline.find((entry) => entry.id === selectedEntryId) ?? run?.timeline[0]
})

function messageFromError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function firstEntry(run: TraceRunSummary | undefined): string {
  return run?.timeline[0]?.id ?? ''
}

export const refreshTraceLogsAtom = atom<null, [], Promise<void>>(null, async (get, set) => {
  if (get(traceLoadStateAtom).status === 'loading') return
  set(traceLoadStateAtom, { status: 'loading', startedAt: Date.now() })
  try {
    const reader = await createTraceLogReader()
    const snapshot = await reader.readAll()
    const view = buildTraceView(snapshot, get(traceFiltersAtom))
    const currentRunId = get(selectedTraceRunIdAtom)
    const currentEntryId = get(selectedTraceEntryIdAtom)
    const run = view.runs.find((entry) => entry.id === currentRunId) ?? view.runs[0]
    const selectedEntry =
      run?.timeline.find((entry) => entry.id === currentEntryId) ?? run?.timeline[0]

    set(traceSnapshotAtom, snapshot)
    set(selectedTraceRunIdAtom, run?.id ?? '')
    set(selectedTraceEntryIdAtom, selectedEntry?.id ?? '')
    set(traceLoadStateAtom, {
      status: 'ready',
      source: snapshot.source,
      loadedAt: snapshot.loadedAt,
    })
  } catch (err) {
    set(traceLoadStateAtom, {
      status: 'error',
      error: messageFromError(err),
    })
  }
})

export const updateTraceFiltersAtom = atom<null, [Partial<TraceFilters>], void>(null, (get, set, patch) => {
  const nextFilters = normalizeTraceFilters({ ...get(traceFiltersAtom), ...patch })
  const snapshot = get(traceSnapshotAtom) ?? EMPTY_SNAPSHOT
  const nextView = buildTraceView(snapshot, nextFilters)
  const currentRunId = get(selectedTraceRunIdAtom)
  const currentEntryId = get(selectedTraceEntryIdAtom)
  const run = nextView.runs.find((entry) => entry.id === currentRunId) ?? nextView.runs[0]
  const selectedEntry =
    run?.timeline.find((entry) => entry.id === currentEntryId) ?? run?.timeline[0]

  set(traceFiltersAtom, nextFilters)
  set(selectedTraceRunIdAtom, run?.id ?? '')
  set(selectedTraceEntryIdAtom, selectedEntry?.id ?? '')
})

export const selectTraceRunAtom = atom<null, [string], void>(null, (get, set, runId) => {
  const run = get(traceViewAtom).runs.find((entry) => entry.id === runId)
  set(selectedTraceRunIdAtom, run?.id ?? '')
  set(selectedTraceEntryIdAtom, firstEntry(run))
})

export const selectTraceEntryAtom = atom<null, [string], void>(null, (_get, set, entryId) => {
  set(selectedTraceEntryIdAtom, entryId)
})
