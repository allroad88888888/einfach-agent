import type { ModelItem } from '@web-agent/ai'
import { defaultCore } from '../runtime/core/coreInstance'
import {
  classifyTimedToolRisk,
  dispatchTimedToolRegistrations,
  type TimedToolRegistration,
} from '../runtime/timedDispatch'
import type { ToolResult } from '../tools/types'
import { loadVisibleChildTool } from './childToolVisibility'
import { subagentResultPath } from './skillCache'
import type { ChildAgentResult } from './types'
import type {
  DelegateAgentCallContext,
  DelegateAgentChildSpec,
  SubagentNodeRecord,
} from './types'
import {
  type ChildChangeSet,
  DelegateAgentRuntimeState,
  isAbortError,
  toErrorMessage,
} from './runtimeState'

/** Shapes a completed child result consistently for both success and failure paths. */
export function createChildResult(
  status: ChildAgentResult['status'],
  base: Pick<ChildAgentResult, 'path' | 'objective' | 'summary' | 'skillFiles' | 'skillIds' | 'changeSets'>,
  extra: Omit<ChildAgentResult, 'path' | 'status' | 'objective' | 'summary' | 'skillFiles' | 'skillIds' | 'changeSets'>,
): ChildAgentResult {
  return { status, ...base, ...extra }
}

function childTimingCore(runtime: DelegateAgentRuntimeState) {
  const core = runtime.opts.core ?? defaultCore
  return runtime.registry === core.tools ? core : undefined
}

function isChildTimedToolVisible(
  registration: TimedToolRegistration,
  allowedToolNames: readonly string[],
  runtime: DelegateAgentRuntimeState,
): boolean {
  if (!allowedToolNames.includes(registration.name)) return false
  // Timed tools intentionally have no model schema; retain the same Web host exclusion from child visibility.
  return loadVisibleChildTool(registration.name, runtime) !== undefined
    || registration.runtime !== 'server'
    || runtime.opts.runtimeIsTauri === true
}

/** Executes one child timing bucket through the child context and archives only its child-timeline result. */
export async function dispatchChildTimedTools(input: {
  runtime: DelegateAgentRuntimeState
  context: DelegateAgentCallContext
  archiveBasePath: string
  node: SubagentNodeRecord
  timing: 'subagentStart' | 'subagentEnd'
  turn: number
  allowedToolNames: readonly string[]
  executedToolNames: string[]
  changeSets: ChildChangeSet[]
}): Promise<void> {
  const { runtime, context, archiveBasePath, node, timing, turn, allowedToolNames } = input
  const core = childTimingCore(runtime)
  if (!core) return
  const registrations = core.timedToolRegistrations(timing)
  if (registrations.length === 0) return
  try {
    await dispatchTimedToolRegistrations({
      registrations,
      // 收尾钩子在中止后仍需留下终态记录；它不会在该状态下实际启动工具。
      isCurrent: () => timing === 'subagentEnd' || !runtime.opts.signal.aborted,
      canDispatch: (registration) => isChildTimedToolVisible(registration, allowedToolNames, runtime),
      createCallId: (name) => `timed:${timing}:${runtime.opts.runId}:${node.path}:${name}`,
      execute: async ({ name, registrationVersion }) => {
        if (runtime.opts.signal.aborted) {
          return { ok: false, error: `子 agent 已中止，未执行到点工具 ${name}` }
        }
        const risk = await classifyTimedToolRisk({ core, sessionId: runtime.opts.sessionId, name })
        if (risk.level !== 'safe') {
          return {
            ok: false,
            error: `到点工具 ${name} 因风险等级 ${risk.level} 被拒绝执行`,
            details: { timing, risk: risk.level },
          }
        }
        return context.runChildTool
          ? context.runChildTool(name, {}, registrationVersion)
          : { ok: false, error: `child tool unavailable: ${name}` }
      },
      isAbortError: (error) => isAbortError(error, runtime.opts.signal),
      errorMessage: toErrorMessage,
      record: async (registration, callId, result) => {
        if ('ok' in result) {
          input.executedToolNames.push(registration.name)
          if (result.ok) runtime.observeChangeSets(result.data, input.changeSets)
        }
        await runtime.archive.bestEffortRecordTraceItem(
          context, archiveBasePath, node.path, turn, childTimedToolTraceItem(callId, result),
        )
      },
    })
  } catch {
    // 到点分派自身不应覆盖子 run 的正常收尾状态。
  }
}

/** Formats a timed child result for the child trace without creating an orphan model tool message. */
export function childTimedToolTraceItem(callId: string, result: ToolResult): ModelItem {
  return {
    role: 'tool',
    tool_call_id: callId,
    content: JSON.stringify(
      'pause' in result
        ? { error: 'child tools cannot pause' }
        : result.ok
          ? result.warnings?.length
            ? { data: result.data ?? { ok: true }, warnings: result.warnings }
            : (result.data ?? { ok: true })
          : {
              error: result.error,
              ...(result.code ? { code: result.code } : {}),
              ...(result.hint ? { hint: result.hint } : {}),
              ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
              ...(result.details !== undefined ? { details: result.details } : {}),
            },
    ),
  }
}

/** Persists a terminal child outcome before returning its stable result shape. */
export async function finalizeChildResult(input: {
  runtime: DelegateAgentRuntimeState
  context: DelegateAgentCallContext
  archiveBasePath: string
  node: SubagentNodeRecord
  spec: DelegateAgentChildSpec
  status: ChildAgentResult['status']
  summary: string
  skillFiles: string[]
  skillIds: string[]
  changeSets: ChildChangeSet[]
  modelTier: NonNullable<ChildAgentResult['modelTier']>
  routeReason: NonNullable<ChildAgentResult['routeReason']>
  fallbackCount: number
  error?: string
}): Promise<ChildAgentResult> {
  const { runtime, context, archiveBasePath, node, spec, status, summary, skillFiles, skillIds } = input
  const resultFile = status === 'done' ? subagentResultPath(archiveBasePath, node.path) : undefined
  if (resultFile) await runtime.archive.writeText(context, resultFile, `${summary.trim()}\n`)
  runtime.scheduler.markNode(runtime.opts.runId, node.path, status, {
    ...(resultFile ? { resultFile } : {}),
    ...(input.error ? { error: input.error } : {}),
    localSkillFiles: [input.skillFiles.at(-1) ?? ''],
    localSkillIds: [input.skillIds.at(-1) ?? ''],
    inheritedSkillFiles: input.skillFiles.slice(0, -1),
    inheritedSkillIds: input.skillIds.slice(0, -1),
  })
  await runtime.archive[status === 'done' ? 'recordEvent' : 'bestEffortRecordEvent'](
    context,
    archiveBasePath,
    'child_finished',
    node.path,
    {
      status, objective: spec.objective, summary, ...(input.error ? { error: input.error } : {}),
      ...(resultFile ? { resultFile } : {}), skillFiles, skillIds,
      modelTier: input.modelTier, route_reason: input.routeReason, fallback_count: input.fallbackCount,
    },
  )
  return createChildResult(status, {
    path: node.path, objective: spec.objective, summary, skillFiles, skillIds, changeSets: input.changeSets,
  }, {
    ...(resultFile ? { resultFile } : {}), modelTier: input.modelTier, routeReason: input.routeReason,
    fallbackCount: input.fallbackCount, ...(input.error ? { error: input.error } : {}),
  })
}
