// Run changes journal only changed fields; outcome facts are diffed by callId.
import type { History, HistoryOp } from '@einfach/core'
import type { RunState, ToolCallOutcomeFact } from './core.type'
import { runAtom } from './sessionAtoms'
import { inTurnTransaction, type SlotWriteTarget } from './sessionSlotWrite'

export const RUN_PATCH_KEY = 'run:patch'

// null removes a field; {} survives JSON as an explicitly undefined field.
type FieldValue = { value?: unknown } | null
interface RunPatch {
  runId: string
  fields: Record<string, FieldValue>
  outcomes?: Record<string, ToolCallOutcomeFact | null>
}

type Equal = (left: unknown, right: unknown) => boolean
const owns = (value: object, key: string): boolean => Object.hasOwn(value, key)

function field(value: object, key: string): FieldValue {
  return owns(value, key) ? { value: (value as Record<string, unknown>)[key] } : null
}

function diff(current: RunState, next: RunState, equal: Equal): [RunPatch, RunPatch] {
  const before: RunPatch = { runId: current.runId, fields: {} }
  const after: RunPatch = { runId: next.runId, fields: {} }
  for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
    if (key === 'toolCallOutcomes') continue
    const previous = field(current, key)
    const updated = field(next, key)
    if ((previous === null) === (updated === null) && equal(previous?.value, updated?.value)) continue
    before.fields[key] = previous
    after.fields[key] = updated
  }

  const previous = current.toolCallOutcomes
  const updated = next.toolCallOutcomes
  // Preserve absent / undefined / empty-map distinctions without storing the map twice.
  if ((previous === undefined) !== (updated === undefined)
    || owns(current, 'toolCallOutcomes') !== owns(next, 'toolCallOutcomes')) {
    before.fields.toolCallOutcomes = previous === undefined ? field(current, 'toolCallOutcomes') : { value: {} }
    after.fields.toolCallOutcomes = updated === undefined ? field(next, 'toolCallOutcomes') : { value: {} }
  }
  if (!Object.is(previous, updated)) {
    const oldFacts: NonNullable<RunPatch['outcomes']> = {}
    const newFacts: NonNullable<RunPatch['outcomes']> = {}
    for (const id of new Set([...Object.keys(previous ?? {}), ...Object.keys(updated ?? {})])) {
      const oldFact = previous && owns(previous, id) ? previous[id] : undefined
      const newFact = updated && owns(updated, id) ? updated[id] : undefined
      if (equal(oldFact, newFact)) continue
      // defineProperty also treats provider-supplied '__proto__' call ids as ordinary keys.
      Object.defineProperty(oldFacts, id, { value: oldFact ?? null, enumerable: true })
      Object.defineProperty(newFacts, id, { value: newFact ?? null, enumerable: true })
    }
    if (Object.keys(oldFacts).length && previous !== undefined) before.outcomes = oldFacts
    if (Object.keys(newFacts).length && updated !== undefined) after.outcomes = newFacts
  }
  return [before, after]
}

/** Creation, removal and run replacement keep the legacy whole-value operation. */
export function runChangeOp(
  current: RunState | undefined,
  next: RunState | undefined,
  equal: Equal = Object.is,
): HistoryOp {
  if (!current || !next || current.runId !== next.runId) {
    return { key: 'run', before: current, after: next }
  }
  const [before, after] = diff(current, next, equal)
  return { key: RUN_PATCH_KEY, before, after }
}

export function registerRunAppliers(history: History): void {
  history.registerApplier(RUN_PATCH_KEY, (get, set, op, direction) => {
    const patch = (direction === 'undo' ? op.before : op.after) as RunPatch
    const current = get(runAtom)
    if (!patch || !patch.fields || !current || current.runId !== patch.runId) return false
    const next = { ...current } as RunState & Record<string, unknown>
    for (const [key, entry] of Object.entries(patch.fields)) {
      if (entry === null) delete next[key]
      else Object.defineProperty(next, key, { value: entry.value, enumerable: true, configurable: true, writable: true })
    }
    if (patch.outcomes) {
      const outcomes = { ...next.toolCallOutcomes }
      for (const [id, fact] of Object.entries(patch.outcomes)) {
        if (fact === null) delete outcomes[id]
        else Object.defineProperty(outcomes, id, { value: fact, enumerable: true, configurable: true, writable: true })
      }
      next.toolCallOutcomes = outcomes
    }
    set(runAtom, () => next)
    return true
  })
}

export function writeRunLogged(target: SlotWriteTarget, next: RunState | undefined, turnLabel?: string): void {
  const current = target.store.getter(runAtom)
  if (Object.is(current, next)) return
  const op = runChangeOp(current, next)
  if (op.key === RUN_PATCH_KEY) {
    const patch = op.after as RunPatch
    if (!Object.keys(patch.fields).length && !patch.outcomes) return
  }
  inTurnTransaction(target, () => {
    target.store.setter(runAtom, () => next)
    target.history.record(op)
  }, turnLabel)
}
