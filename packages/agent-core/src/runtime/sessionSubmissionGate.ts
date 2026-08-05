import type { CoreInstance } from './core/coreInstance'

interface GateEntry {
  sequence: number
  controller: AbortController
  task: (sequence: number, signal: AbortSignal) => unknown | PromiseLike<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

interface SubmissionGate {
  nextSequence: number
  sessions: Map<string, GateEntry[]>
}

const gates = new WeakMap<CoreInstance, SubmissionGate>()

function gateFor(core: CoreInstance): SubmissionGate {
  const current = gates.get(core)
  if (current) return current
  const created: SubmissionGate = { nextSequence: 0, sessions: new Map() }
  gates.set(core, created)
  return created
}

function settleHead(
  gate: SubmissionGate,
  sessionId: string,
  entry: GateEntry,
  settle: () => void,
): void {
  const queue = gate.sessions.get(sessionId)
  if (!queue || queue[0] !== entry) return
  queue.shift()
  settle()
  if (queue.length) runHead(gate, sessionId, queue)
  else gate.sessions.delete(sessionId)
}

function runHead(gate: SubmissionGate, sessionId: string, queue: GateEntry[]): void {
  const entry = queue[0]
  try {
    const result = entry.task(entry.sequence, entry.controller.signal)
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).then(
        (value) => settleHead(gate, sessionId, entry, () => entry.resolve(value)),
        (error) => settleHead(gate, sessionId, entry, () => entry.reject(error)),
      )
      return
    }
    settleHead(gate, sessionId, entry, () => entry.resolve(result))
  } catch (error) {
    settleHead(gate, sessionId, entry, () => entry.reject(error))
  }
}

/** Serializes submissions for one session while preserving synchronous legacy commits. */
export function scheduleSessionSubmission<T>(
  core: CoreInstance,
  sessionId: string,
  task: (sequence: number, signal: AbortSignal) => T | PromiseLike<T>,
): { sequence: number; promise: Promise<T> } {
  const gate = gateFor(core)
  const sequence = ++gate.nextSequence
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  let rejectPromise!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  const entry: GateEntry = {
    sequence,
    controller: new AbortController(),
    task,
    resolve: (value) => resolvePromise(value as T),
    reject: rejectPromise,
  }
  const queue = gate.sessions.get(sessionId) ?? []
  if (!queue.length) gate.sessions.set(sessionId, queue)
  queue.push(entry)
  if (queue.length === 1) runHead(gate, sessionId, queue)
  return { sequence, promise }
}

/** Aborts the active preparation and every queued submission for one session. */
export function cancelSessionSubmissions(core: CoreInstance, sessionId: string): void {
  const queue = gates.get(core)?.sessions.get(sessionId)
  for (const entry of queue ?? []) entry.controller.abort()
}
