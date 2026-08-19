import { describe, expect, it } from 'vitest'
import type { ModelFunctionTool, ModelItem } from '@einfach-agent/ai'
import {
  contextRequestAssemblyTraceAttrs,
  snapshotContextRequestAssembly,
  snapshotContextRequestStage,
} from './contextRequestAssemblyDiagnostics'

const stable: ModelItem = { role: 'system', content: 'fixed prefix' }
const history: ModelItem = { role: 'user', content: 'user request' }
const plan: ModelItem = { role: 'system', content: 'secret plan snapshot' }
const failure: ModelItem = { role: 'system', content: 'secret failed tool notice' }

const tools: ModelFunctionTool[] = [
  { type: 'function', function: { name: 'write_file', description: 'write', parameters: { type: 'object' } } },
  { type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object' } } },
]

describe('context request assembly diagnostics', () => {
  it('attributes dynamic controls and hook rewrites without retaining prompt content', () => {
    const raw = [stable, history, plan, failure]
    const assembly = snapshotContextRequestAssembly({
      rawMessages: raw,
      stablePrefixItems: 1,
      historyItems: 1,
      controls: [plan, failure],
      controlSources: ['plan_snapshot', 'tool_failure_notice'],
      tools,
    })
    const afterTransform = snapshotContextRequestStage([
      stable,
      { role: 'assistant', content: 'compacted history' },
      plan,
      failure,
    ])
    const final = snapshotContextRequestStage([
      stable,
      { role: 'assistant', content: 'compacted history' },
      { role: 'system', content: 'changed plan snapshot' },
      failure,
    ])

    const attrs = contextRequestAssemblyTraceAttrs({ assembly, afterTransform, final })

    expect(attrs).toMatchObject({
      cache_assembly_raw_items: 4,
      cache_assembly_stable_prefix_items: 1,
      cache_assembly_history_items: 1,
      cache_assembly_controls_items: 2,
      cache_assembly_control_plan_snapshot_items: 1,
      cache_assembly_control_plan_continuation_items: 0,
      cache_assembly_control_tool_failure_notice_items: 1,
      cache_assembly_control_unknown_items: 0,
      cache_assembly_tool_names: 'read_file,write_file',
      cache_assembly_transform_changed: true,
      cache_assembly_transform_first_changed_item_index: 1,
      cache_assembly_prepare_changed: true,
      cache_assembly_prepare_first_changed_item_index: 2,
      cache_assembly_final_control_tail_changed: true,
    })
    expect(String(attrs.cache_assembly_control_plan_snapshot_fingerprint)).toContain('request-assembly-control-plan_snapshot-v2-fnv1a32-')
    expect(JSON.stringify(attrs)).not.toContain('secret')
  })

  it('attributes an unlabeled control to unknown instead of guessing from content', () => {
    const assembly = snapshotContextRequestAssembly({
      rawMessages: [stable, plan],
      stablePrefixItems: 1,
      historyItems: 0,
      controls: [plan],
      controlSources: [],
      tools: [],
    })

    expect(contextRequestAssemblyTraceAttrs({
      assembly,
      afterTransform: snapshotContextRequestStage([stable, plan]),
      final: snapshotContextRequestStage([stable, plan]),
    })).toMatchObject({
      cache_assembly_control_unknown_items: 1,
      cache_assembly_control_plan_snapshot_items: 0,
      cache_assembly_transform_changed: false,
      cache_assembly_prepare_changed: false,
    })
  })
})
