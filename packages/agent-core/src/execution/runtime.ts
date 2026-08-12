import type { CoreInstance } from '../runtime/core/coreInstance'
import { newId } from '../runtime/newId'
import { sessionsAtom } from '../state/rootStore'
import type { SubagentNodeRecord } from '../runtime/delegationContract'
import {
  createExecutionNode,
  executionEventsAtom,
  executionGraphAtom,
  reduceExecutionGraph,
} from './graph'
import type {
  ExecutionEvent,
  ExecutionHandle,
  ExecutionJoinResult,
  ExecutionNodeType,
  ExecutionObservation,
  ExecutionTraceRecord,
} from './types'

interface RunningExecution {
  promise: Promise<unknown>
  controller: AbortController
}

export interface SpawnExecutionInput {
  sessionId: string
  runId: string
  label: string
  parentId?: string
  task(signal: AbortSignal): Promise<unknown>
}

export interface ExecutionRuntime {
  spawn(input: SpawnExecutionInput): ExecutionHandle
  run<T>(input: {
    id: string
    graphId: string
    sessionId: string
    runId: string
    type: ExecutionNodeType
    label: string
    parentId?: string
    effectKeys?: string[]
    task(signal: AbortSignal): Promise<T>
    signal?: AbortSignal
  }): Promise<T>
  observe(sessionId: string, executionId: string): ExecutionObservation
  join(sessionId: string, executionId: string, timeoutMs?: number): Promise<ExecutionJoinResult>
  cancel(sessionId: string, executionId: string): boolean
  syncAgentNode(node: SubagentNodeRecord): void
  appendAgentTrace(input: {
    sessionId: string
    treeId: string
    agentPath: string
    record: ExecutionTraceRecord
  }): void
  interruptPersisted(sessionId: string): void
}

const runtimes = new WeakMap<CoreInstance, ExecutionRuntime>()

function eventForStatus(
  nodeId: string,
  status: 'running' | 'succeeded' | 'failed' | 'cancelled',
  patch?: { result?: unknown; error?: string },
): ExecutionEvent {
  return {
    type: 'node.status',
    nodeId,
    status,
    at: Date.now(),
    attempt: 1,
    generation: 1,
    ...patch,
  }
}

function executionAbortError(signal: AbortSignal): Error {
  const reason = signal.reason
  const error = reason instanceof Error ? reason : new Error('execution cancelled')
  error.name = 'AbortError'
  return error
}

export function getExecutionRuntime(core: CoreInstance): ExecutionRuntime {
  const existing = runtimes.get(core)
  if (existing) return existing

  const running = new Map<string, RunningExecution>()

  function dispatch(sessionId: string, event: ExecutionEvent): void {
    const store = core.getSessionStore(sessionId).store
    store.setter(executionGraphAtom, (graph) => reduceExecutionGraph(graph, event))
    store.setter(executionEventsAtom, (events) => [...events, event])
    const graph = store.getter(executionGraphAtom)
    core.rootStore.setter(sessionsAtom, (previous) => {
      const session = previous[sessionId]
      if (!session) return previous
      return {
        ...previous,
        [sessionId]: {
          ...session,
          executionGraph: graph,
          updatedAt: Date.now(),
        },
      }
    })
    core.persistence.persistSessions()
  }

  const runtime: ExecutionRuntime = {
    spawn(input) {
      const executionId = newId()
      const graphId = input.runId
      const node = createExecutionNode({
        id: executionId,
        graphId,
        sessionId: input.sessionId,
        runId: input.runId,
        type: 'agent-batch',
        label: input.label,
        parentId: input.parentId,
      })
      dispatch(input.sessionId, { type: 'node.added', node })
      dispatch(input.sessionId, eventForStatus(executionId, 'running'))

      const controller = new AbortController()
      const promise = Promise.resolve()
        .then(() => input.task(controller.signal))
        .then((result) => {
          dispatch(input.sessionId, eventForStatus(executionId, 'succeeded', { result }))
          return result
        })
        .catch((error: unknown) => {
          const cancelled = controller.signal.aborted
            || (error instanceof Error && error.name === 'AbortError')
          dispatch(input.sessionId, eventForStatus(
            executionId,
            cancelled ? 'cancelled' : 'failed',
            { error: error instanceof Error ? error.message : String(error) },
          ))
          throw error
        })
        .finally(() => {
          running.delete(executionId)
        })
      void promise.catch(() => undefined)
      running.set(executionId, { promise, controller })

      return { executionId, graphId, nodeIds: [executionId], status: 'scheduled' }
    },

    async run<T>(input: {
      id: string
      graphId: string
      sessionId: string
      runId: string
      type: ExecutionNodeType
      label: string
      parentId?: string
      effectKeys?: string[]
      task(signal: AbortSignal): Promise<T>
      signal?: AbortSignal
    }): Promise<T> {
      dispatch(input.sessionId, {
        type: 'node.added',
        node: createExecutionNode({
          id: input.id,
          graphId: input.graphId,
          sessionId: input.sessionId,
          runId: input.runId,
          type: input.type,
          label: input.label,
          parentId: input.parentId,
          effectKeys: input.effectKeys,
        }),
      })
      dispatch(input.sessionId, eventForStatus(input.id, 'running'))
      const controller = new AbortController()
      const abort = () => controller.abort(input.signal?.reason)
      input.signal?.addEventListener('abort', abort, { once: true })
      if (input.signal?.aborted) abort()
      try {
        const result = await input.task(controller.signal)
        if (controller.signal.aborted) {
          throw executionAbortError(controller.signal)
        }
        dispatch(input.sessionId, eventForStatus(input.id, 'succeeded', { result }))
        return result
      } catch (error) {
        const cancelled = controller.signal.aborted
          || (error instanceof Error && error.name === 'AbortError')
        dispatch(input.sessionId, eventForStatus(
          input.id,
          cancelled ? 'cancelled' : 'failed',
          { error: error instanceof Error ? error.message : String(error) },
        ))
        throw error
      } finally {
        input.signal?.removeEventListener('abort', abort)
      }
    },

    observe(sessionId, executionId) {
      const graph = core.getSessionStore(sessionId).store.getter(executionGraphAtom)
      return {
        node: graph.nodes[executionId],
        children: graph.order
          .map((id) => graph.nodes[id])
          .filter((node) => node?.parentId === executionId),
      }
    },

    async join(sessionId, executionId, timeoutMs) {
      const active = running.get(executionId)
      const beforeJoin = core.getSessionStore(sessionId).store
        .getter(executionGraphAtom).nodes[executionId]
      const terminal = beforeJoin && (
        beforeJoin.status === 'succeeded'
        || beforeJoin.status === 'failed'
        || beforeJoin.status === 'cancelled'
      )
      let timedOut = false
      if (active && !terminal) {
        if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            const outcome = await Promise.race([
              active.promise.then(
                () => 'settled' as const,
                () => 'settled' as const,
              ),
              new Promise<'timeout'>((resolve) => {
                timer = setTimeout(() => resolve('timeout'), timeoutMs)
              }),
            ])
            timedOut = outcome === 'timeout'
          } finally {
            if (timer !== undefined) clearTimeout(timer)
          }
        } else {
          try {
            await active.promise
          } catch {
            // The graph node contains the normalized failure.
          }
        }
      }
      const node = core.getSessionStore(sessionId).store.getter(executionGraphAtom).nodes[executionId]
      if (!node) {
        return { executionId, status: 'failed', error: `unknown execution: ${executionId}` }
      }
      return {
        executionId,
        status: node.status,
        result: node.result,
        error: node.error,
        ...(timedOut ? { timedOut: true } : {}),
      }
    },

    cancel(sessionId, executionId) {
      const active = running.get(executionId)
      if (!active || active.controller.signal.aborted) return false
      active.controller.abort()
      dispatch(sessionId, eventForStatus(executionId, 'cancelled', { error: 'cancelled' }))
      return true
    },

    syncAgentNode(node) {
      const status = node.status === 'done'
        ? 'succeeded'
        : node.status === 'failed'
          ? 'failed'
          : node.status === 'cancelled'
            ? 'cancelled'
            : node.status === 'queued'
              ? 'queued'
              : 'running'
      const store = core.getSessionStore(node.sessionId).store
      const current = store.getter(executionGraphAtom).nodes[node.id]
      if (!current) {
        dispatch(node.sessionId, {
          type: 'node.added',
          node: createExecutionNode({
            id: node.id,
            graphId: node.treeId,
            sessionId: node.sessionId,
            runId: node.treeId,
            type: 'agent',
            label: node.objective,
            parentId: node.parentPath ? `${node.treeId}:${node.parentPath}` : undefined,
            now: node.createdAt,
          }),
        })
      }
      dispatch(node.sessionId, {
        type: 'node.status',
        nodeId: node.id,
        status,
        at: node.updatedAt,
        attempt: 1,
        generation: 1,
        result: {
          path: node.path,
          delegationCallId: node.delegationCallId,
          resultFile: node.resultFile,
          skillFiles: node.localSkillFiles,
          skillIds: node.localSkillIds,
        },
        error: node.error,
      })
    },

    appendAgentTrace(input) {
      dispatch(input.sessionId, {
        type: 'node.trace',
        nodeId: `${input.treeId}:${input.agentPath}`,
        record: input.record,
      })
    },

    interruptPersisted(sessionId) {
      dispatch(sessionId, { type: 'graph.hydrated', at: Date.now() })
    },
  }

  runtimes.set(core, runtime)
  return runtime
}
