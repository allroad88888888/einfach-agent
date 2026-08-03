export type WriteQueueMode = 'latest' | 'serial'

export interface WriteQueueMetadata {
  queueDepthAtEnqueue: number
  coalescedCalls: number
}

export type WriteQueueTask = (metadata: WriteQueueMetadata) => Promise<void>

export interface WriteQueue {
  enqueue(key: string, task: WriteQueueTask): void
  reset(): void
}

interface LatestEntry {
  task: WriteQueueTask
  coalescedCalls: number
}

interface QueueState {
  generation: number
  depth: number
  tail?: Promise<void>
  pending?: LatestEntry
}

/** Serializes persistence writes by key, optionally retaining only the newest pending write. */
export function createWriteQueue(mode: WriteQueueMode): WriteQueue {
  const states = new Map<string, QueueState>()
  let generation = 0

  function invoke(task: WriteQueueTask, metadata: WriteQueueMetadata): Promise<void> {
    try {
      return Promise.resolve(task(metadata))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  function stateFor(key: string): QueueState {
    const existing = states.get(key)
    if (existing && existing.generation === generation) return existing
    const state: QueueState = { generation, depth: 0 }
    states.set(key, state)
    return state
  }

  function settleLatest(key: string, state: QueueState): void {
    if (state.generation !== generation || states.get(key) !== state) return
    const next = state.pending
    state.pending = undefined
    if (next) {
      runLatest(key, state, next, 2)
      return
    }
    states.delete(key)
  }

  function runLatest(
    key: string,
    state: QueueState,
    entry: LatestEntry,
    queueDepthAtEnqueue: number,
  ): void {
    void invoke(entry.task, { queueDepthAtEnqueue, coalescedCalls: entry.coalescedCalls }).then(
      () => settleLatest(key, state),
      () => settleLatest(key, state),
    )
  }

  function enqueueLatest(key: string, task: WriteQueueTask): void {
    const state = stateFor(key)
    if (state.depth === 0) {
      state.depth = 1
      runLatest(key, state, { task, coalescedCalls: 0 }, 1)
      return
    }
    state.pending = {
      task,
      coalescedCalls: (state.pending?.coalescedCalls ?? 0) + 1,
    }
  }

  function enqueueSerial(key: string, task: WriteQueueTask): void {
    const state = stateFor(key)
    const metadata: WriteQueueMetadata = {
      queueDepthAtEnqueue: state.depth + 1,
      coalescedCalls: 0,
    }
    state.depth = metadata.queueDepthAtEnqueue
    const write = state.tail
      ? state.tail.then(() => invoke(task, metadata))
      : invoke(task, metadata)
    const settled = write.catch(() => undefined)
    state.tail = settled
    void settled.then(() => {
      state.depth = Math.max(0, state.depth - 1)
      if (
        state.generation === generation
        && states.get(key) === state
        && state.depth === 0
        && state.tail === settled
      ) {
        states.delete(key)
      }
    })
  }

  return {
    enqueue(key, task) {
      if (mode === 'latest') enqueueLatest(key, task)
      else enqueueSerial(key, task)
    },
    reset() {
      generation += 1
      states.clear()
    },
  }
}
