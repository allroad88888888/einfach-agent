import { createContextCacheTracker, type ContextCacheTracker } from '../runtime/contextCache'
import type { CoreInstance } from '../runtime/core/coreInstance'
import { normalizePrimaryAgentSettings } from '../state/persistence/modelMigration'
import type { ModelSettings } from '../state/core.type'
import { toolRegistry } from '../tools/registry'
import type { ToolRegistry } from '../tools/toolRegistry'
import { SubagentArchiveIO } from './archiveIO'
import { createConcurrencyLimiter, type ConcurrencyLimiter } from './concurrency'
import { ROOT_AGENT_PATH } from './path'
import { createSubagentScheduler, type SubagentScheduler } from './schedulerState'
import type {
  DelegateAgentBatchResult,
  DelegateAgentInput,
  SubagentNodeRecord,
  SubagentToolProfile,
} from './types'

export interface TreeRuntimeBudget {
  maxDepth: number
  maxChildren: number
  maxConcurrent: number
  maxTotalNodes: number
  maxModelCalls: number
}

export interface DelegationCallState {
  rootBudget: TreeRuntimeBudget
  modelCallLimiter: ConcurrencyLimiter
  totalNodesUsed: number
  modelCallsUsed: number
  budgetByPath: Map<string, TreeRuntimeBudget>
  toolProfileByPath: Map<string, SubagentToolProfile>
  confirmedToolsByPath: Map<string, readonly string[]>
}

export type ChildChangeSet = { id: string; reversible: boolean }

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'unknown error'
}

export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError')
}

export interface CreateDelegateAgentRuntimeOptions {
  sessionId: string
  runId: string
  settings: ModelSettings
  /** Core that owns the archive write lock. Defaults to the legacy default core. */
  core?: CoreInstance
  /** Registry owned by the current CoreInstance. Defaults to the legacy singleton for direct callers. */
  registry?: ToolRegistry
  /** Scheduler owned by the current CoreInstance. Defaults to a legacy module-local fallback. */
  scheduler?: SubagentScheduler
  customInstructions?: string
  /** Parent agent's resolved execution-environment prompt section. */
  environment?: string
  /** Whether this delegate runtime runs inside the native Tauri host. Omitted is Web-safe. */
  runtimeIsTauri?: boolean
  /** Stable, opaque installation identifier sent only to DeepSeek request bodies. */
  deepseekUserId?: string
  apiKey: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
  onNodeChange?(node: SubagentNodeRecord): void
  onTraceItem?(input: {
    agentPath: string
    timestamp: string
    turn: number
    item: import('@web-agent/ai').ModelItem
  }): void
}

// Compatibility only for direct createDelegateAgentRuntime callers that have
// not yet been assembled through a Core delegation capability.
let fallbackScheduler: SubagentScheduler | undefined

function getFallbackScheduler(): SubagentScheduler {
  return fallbackScheduler ??= createSubagentScheduler()
}

export function collectChangeSets(value: unknown, target: ChildChangeSet[]): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item) => collectChangeSets(item, target))
    return
  }
  const record = value as Record<string, unknown>
  const candidate = record.changeSet
  if (
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    && typeof (candidate as Record<string, unknown>).id === 'string'
    && typeof (candidate as Record<string, unknown>).reversible === 'boolean'
  ) {
    const summary = candidate as ChildChangeSet
    if (!target.some((item) => item.id === summary.id)) {
      target.push({ id: summary.id, reversible: summary.reversible })
    }
  }
  if (!Array.isArray(record.changeSets)) return
  for (const item of record.changeSets) {
    if (
      item && typeof item === 'object' && !Array.isArray(item)
      && typeof (item as Record<string, unknown>).id === 'string'
      && typeof (item as Record<string, unknown>).reversible === 'boolean'
      && !target.some((existing) => existing.id === (item as ChildChangeSet).id)
    ) {
      target.push({
        id: (item as ChildChangeSet).id,
        reversible: (item as ChildChangeSet).reversible,
      })
    }
  }
}

/** Owns the mutable resources and lifecycle of one delegate-agent runtime. */
export class DelegateAgentRuntimeState {
  readonly registry: ToolRegistry
  readonly scheduler: SubagentScheduler
  readonly ownerSignal: AbortSignal
  readonly runtimeController: AbortController
  readonly abortFromOwner: () => void
  readonly migratedSettings: ModelSettings
  readonly opts: CreateDelegateAgentRuntimeOptions
  readonly archive: SubagentArchiveIO
  readonly contextCacheTracker: ContextCacheTracker
  nextChangeSetOrder = 0
  readonly changeSetOrder = new Map<string, number>()
  readonly delegationStateByChildPath = new Map<string, DelegationCallState>()
  lowCostExtractionState: DelegationCallState | undefined
  owners = 1
  disposed = false
  cleanup: Promise<void> | undefined
  readonly unsubscribeScheduler: (() => void) | undefined

  constructor(rawOpts: CreateDelegateAgentRuntimeOptions) {
    this.registry = rawOpts.registry ?? toolRegistry
    this.scheduler = rawOpts.scheduler ?? getFallbackScheduler()
    this.ownerSignal = rawOpts.signal
    this.runtimeController = new AbortController()
    this.abortFromOwner = () => this.runtimeController.abort(this.ownerSignal.reason)
    this.ownerSignal.addEventListener('abort', this.abortFromOwner, { once: true })
    if (this.ownerSignal.aborted) this.abortFromOwner()
    this.migratedSettings = normalizePrimaryAgentSettings(rawOpts.settings)
    this.opts = {
      ...rawOpts,
      runtimeIsTauri: rawOpts.runtimeIsTauri === true,
      settings: this.migratedSettings,
      signal: this.runtimeController.signal,
    }
    this.archive = new SubagentArchiveIO({
      core: this.opts.core,
      sessionId: this.opts.sessionId,
      runId: this.opts.runId,
      model: this.opts.settings.model,
      vendor: this.opts.settings.vendor,
      onTraceItem: this.opts.onTraceItem,
    })
    this.contextCacheTracker = createContextCacheTracker()
    this.unsubscribeScheduler = this.opts.onNodeChange
      ? this.scheduler.subscribe((node) => {
          if (node.treeId === this.opts.runId && node.sessionId === this.opts.sessionId) {
            this.opts.onNodeChange?.(node)
          }
        })
      : undefined
  }

  createDelegationCallState(input?: Pick<
    DelegateAgentInput,
    'maxDepth' | 'maxChildren' | 'maxConcurrent' | 'maxTotalNodes' | 'maxModelCalls'
  >): DelegationCallState {
    const rootBudget: TreeRuntimeBudget = {
      maxDepth: input?.maxDepth ?? 2,
      maxChildren: input?.maxChildren ?? 6,
      maxConcurrent: input?.maxConcurrent ?? 4,
      maxTotalNodes: input?.maxTotalNodes ?? 64,
      maxModelCalls: input?.maxModelCalls ?? 128,
    }
    return {
      rootBudget,
      modelCallLimiter: createConcurrencyLimiter(rootBudget.maxConcurrent),
      totalNodesUsed: 1,
      modelCallsUsed: 0,
      budgetByPath: new Map([[ROOT_AGENT_PATH, rootBudget]]),
      toolProfileByPath: new Map(),
      confirmedToolsByPath: new Map(),
    }
  }

  reserveNodes(state: DelegationCallState, count: number, limit: number): void {
    const effectiveLimit = Math.min(state.rootBudget.maxTotalNodes, limit)
    const remaining = Math.max(0, effectiveLimit - state.totalNodesUsed)
    if (count > remaining) {
      throw new Error(
        `subagent tree node budget exhausted: requested ${count}, remaining ${remaining}, used ${state.totalNodesUsed} of ${effectiveLimit}`,
      )
    }
    state.totalNodesUsed += count
  }

  reserveModelCall(state: DelegationCallState, limit: number): void {
    const effectiveLimit = Math.min(state.rootBudget.maxModelCalls, limit)
    if (state.modelCallsUsed >= effectiveLimit) {
      throw new Error(
        `subagent tree model-call budget exhausted: used ${state.modelCallsUsed} of ${effectiveLimit}`,
      )
    }
    state.modelCallsUsed += 1
  }

  budgetUsage(state: DelegationCallState): DelegateAgentBatchResult['budgetUsage'] {
    return {
      totalNodes: { used: state.totalNodesUsed, limit: state.rootBudget.maxTotalNodes },
      modelCalls: { used: state.modelCallsUsed, limit: state.rootBudget.maxModelCalls },
    }
  }

  observeChangeSets(value: unknown, target: ChildChangeSet[]): void {
    collectChangeSets(value, target)
    for (const changeSet of target) {
      if (!this.changeSetOrder.has(changeSet.id)) {
        this.changeSetOrder.set(changeSet.id, this.nextChangeSetOrder++)
      }
    }
  }

  retain(): void {
    if (this.disposed) throw new Error('delegate runtime already disposed')
    this.owners += 1
  }

  releaseOwner(): Promise<void> {
    this.owners = Math.max(0, this.owners - 1)
    if (this.owners > 0 || this.disposed) return this.cleanup ?? Promise.resolve()
    this.disposed = true
    this.cleanup = (async () => {
      try {
        const snapshot = this.scheduler.snapshot(this.opts.runId)
        const root = snapshot.find((node) => node.path === ROOT_AGENT_PATH)
        if (root && (root.status === 'queued' || root.status === 'distilling' || root.status === 'running')) {
          const descendants = snapshot.filter((node) => node.path !== ROOT_AGENT_PATH)
          const status = this.opts.signal.aborted || descendants.some((node) =>
            node.status === 'queued' || node.status === 'distilling' || node.status === 'running')
            ? 'cancelled'
            : descendants.some((node) => node.status === 'failed')
              ? 'failed'
              : descendants.some((node) => node.status === 'cancelled')
                ? 'cancelled'
                : 'done'
          this.scheduler.markNode(this.opts.runId, ROOT_AGENT_PATH, status)
        }
        await this.archive.close()
      } finally {
        this.ownerSignal.removeEventListener('abort', this.abortFromOwner)
        this.unsubscribeScheduler?.()
        this.delegationStateByChildPath.clear()
        this.scheduler.clear(this.opts.runId)
      }
    })()
    return this.cleanup
  }
}
