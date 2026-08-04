import type { ModelFunctionTool, ModelItem } from '@web-agent/ai'
import { contextCacheFingerprint } from './contextCacheFingerprint'
import { describeContextProjection, type ContextProjectionItemDiagnostic } from './contextProjectionDiagnostics'

/** Identifies the runtime producer of one dynamic system control without retaining its content. */
export type RequestControlSource =
  // plan_snapshot 已不再产生(P2 拆成 definition/state 两条),保留以兼容历史 trace 字段。
  | 'plan_snapshot'
  | 'plan_definition'
  | 'plan_state'
  | 'plan_continuation'
  | 'tool_failure_notice'
  | 'unknown'

const CONTROL_SOURCES: RequestControlSource[] = ['plan_snapshot', 'plan_definition', 'plan_state', 'plan_continuation', 'tool_failure_notice', 'unknown']

interface RequestStageSnapshot {
  items: ContextProjectionItemDiagnostic[]
  fingerprint: string
}

export interface ContextRequestAssemblySnapshot {
  raw: RequestStageSnapshot
  stablePrefix: RequestStageSnapshot
  history: RequestStageSnapshot
  controls: RequestStageSnapshot
  controlsBySource: Record<RequestControlSource, RequestStageSnapshot>
  toolsFingerprint: string
  toolNames: string
  segmentMismatch: boolean
}

function snapshot(messages: readonly ModelItem[], scope: string): RequestStageSnapshot {
  return {
    items: describeContextProjection(messages),
    fingerprint: contextCacheFingerprint(scope, messages),
  }
}

function sourceMessages(
  controls: readonly ModelItem[],
  sources: readonly RequestControlSource[],
): Record<RequestControlSource, ModelItem[]> {
  const grouped: Record<RequestControlSource, ModelItem[]> = {
    plan_snapshot: [],
    plan_definition: [],
    plan_state: [],
    plan_continuation: [],
    tool_failure_notice: [],
    unknown: [],
  }
  controls.forEach((control, index) => grouped[sources[index] ?? 'unknown'].push(control))
  return grouped
}

/** Captures the request before hooks can rewrite its message array or entries. */
export function snapshotContextRequestAssembly(input: {
  rawMessages: readonly ModelItem[]
  stablePrefixItems: number
  historyItems: number
  controls: readonly ModelItem[]
  controlSources: readonly RequestControlSource[]
  tools: readonly ModelFunctionTool[]
}): ContextRequestAssemblySnapshot {
  const { rawMessages, stablePrefixItems, historyItems, controls, controlSources, tools } = input
  const historyStart = stablePrefixItems
  const controlsStart = historyStart + historyItems
  const groupedControls = sourceMessages(controls, controlSources)
  return {
    raw: snapshot(rawMessages, 'request-assembly-raw'),
    stablePrefix: snapshot(rawMessages.slice(0, historyStart), 'request-assembly-stable-prefix'),
    history: snapshot(rawMessages.slice(historyStart, controlsStart), 'request-assembly-history'),
    controls: snapshot(controls, 'request-assembly-controls'),
    controlsBySource: Object.fromEntries(CONTROL_SOURCES.map((source) => [
      source,
      snapshot(groupedControls[source], `request-assembly-control-${source}`),
    ])) as Record<RequestControlSource, RequestStageSnapshot>,
    toolsFingerprint: contextCacheFingerprint('request-assembly-tools', tools),
    toolNames: tools.map((tool) => tool.function.name).sort().join(','),
    segmentMismatch: rawMessages.length !== controlsStart + controls.length,
  }
}

/** Captures one post-assembly hook boundary without retaining request content. */
export function snapshotContextRequestStage(messages: readonly ModelItem[]): RequestStageSnapshot {
  return snapshot(messages, 'request-assembly-stage')
}

function stageDifference(before: RequestStageSnapshot, after: RequestStageSnapshot) {
  const limit = Math.min(before.items.length, after.items.length)
  let commonPrefixItems = 0
  while (commonPrefixItems < limit && before.items[commonPrefixItems].fingerprint === after.items[commonPrefixItems].fingerprint) {
    commonPrefixItems += 1
  }
  const changed = before.items.length !== after.items.length || commonPrefixItems !== limit
  const previousItem = before.items[commonPrefixItems]
  const currentItem = after.items[commonPrefixItems]
  return {
    changed,
    commonPrefixItems,
    firstChangedItemIndex: previousItem || currentItem ? commonPrefixItems : undefined,
    previousItemRole: previousItem?.role,
    currentItemRole: currentItem?.role,
  }
}

/** Flattens request-assembly provenance for trace fields, with fingerprints only for prompt material. */
export function contextRequestAssemblyTraceAttrs(input: {
  assembly: ContextRequestAssemblySnapshot
  afterTransform: RequestStageSnapshot
  final: RequestStageSnapshot
}): Record<string, unknown> {
  const { assembly, afterTransform, final } = input
  const transform = stageDifference(assembly.raw, afterTransform)
  const prepare = stageDifference(afterTransform, final)
  const finalControls = assembly.controls.items.length > 0
    ? { items: final.items.slice(-assembly.controls.items.length), fingerprint: contextCacheFingerprint('request-assembly-final-controls', final.items.slice(-assembly.controls.items.length)) }
    : assembly.controls
  const tail = stageDifference(assembly.controls, finalControls)
  const attrs: Record<string, unknown> = {
    cache_assembly_raw_fingerprint: assembly.raw.fingerprint,
    cache_assembly_raw_items: assembly.raw.items.length,
    cache_assembly_stable_prefix_fingerprint: assembly.stablePrefix.fingerprint,
    cache_assembly_stable_prefix_items: assembly.stablePrefix.items.length,
    cache_assembly_history_fingerprint: assembly.history.fingerprint,
    cache_assembly_history_items: assembly.history.items.length,
    cache_assembly_controls_fingerprint: assembly.controls.fingerprint,
    cache_assembly_controls_items: assembly.controls.items.length,
    cache_assembly_tools_fingerprint: assembly.toolsFingerprint,
    cache_assembly_tool_names: assembly.toolNames,
    cache_assembly_segment_mismatch: assembly.segmentMismatch,
    cache_assembly_transform_changed: transform.changed,
    cache_assembly_transform_common_prefix_items: transform.commonPrefixItems,
    cache_assembly_transform_first_changed_item_index: transform.firstChangedItemIndex,
    cache_assembly_transform_previous_item_role: transform.previousItemRole,
    cache_assembly_transform_current_item_role: transform.currentItemRole,
    cache_assembly_prepare_changed: prepare.changed,
    cache_assembly_prepare_common_prefix_items: prepare.commonPrefixItems,
    cache_assembly_prepare_first_changed_item_index: prepare.firstChangedItemIndex,
    cache_assembly_prepare_previous_item_role: prepare.previousItemRole,
    cache_assembly_prepare_current_item_role: prepare.currentItemRole,
    cache_assembly_final_fingerprint: final.fingerprint,
    cache_assembly_final_items: final.items.length,
    cache_assembly_final_control_tail_changed: tail.changed,
    cache_assembly_final_control_tail_common_prefix_items: tail.commonPrefixItems,
  }
  for (const source of CONTROL_SOURCES) {
    const sourceSnapshot = assembly.controlsBySource[source]
    attrs[`cache_assembly_control_${source}_fingerprint`] = sourceSnapshot.fingerprint
    attrs[`cache_assembly_control_${source}_items`] = sourceSnapshot.items.length
  }
  return attrs
}
