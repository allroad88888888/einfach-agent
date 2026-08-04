import { describe, expect, it } from 'vitest'
import type { ModelItem } from '@web-agent/ai'
import { createContextCacheTracker } from './contextCache'
import { contextProjectionTraceAttrs } from './contextProjectionDiagnostics'

const system: ModelItem = { role: 'system', content: 'fixed system' }
const user: ModelItem = { role: 'user', content: 'hello' }
const control: ModelItem = { role: 'system', content: 'dynamic control' }

function input(messages: ModelItem[], dynamicControls: ModelItem[] = []) {
  return {
    lane: 'main',
    scope: 'diagnostic-run:root',
    vendor: 'deepseek',
    model: 'deepseek-v4-flash',
    messages,
    systemContent: 'fixed system',
    tools: [],
    compacted: true,
    dynamicControls,
    requestMode: 'tool_loop',
  } as const
}

describe('context projection diagnostics', () => {
  it('labels the initial request without recording prompt contents', () => {
    const profile = createContextCacheTracker().observe(input([system, user, control], [control]))

    expect(profile.projectionDiagnostics).toMatchObject({
      transition: 'initial',
      currentItems: 3,
      currentFactItems: 2,
      dynamicControlFingerprint: expect.stringContaining('dynamic-controls-v2-fnv1a32-'),
    })
    expect(JSON.stringify(profile.projectionDiagnostics)).not.toContain('dynamic control')
  })

  it('distinguishes a fact append from a changed dynamic tail', () => {
    const tracker = createContextCacheTracker()
    tracker.observe(input([system, user, control], [control]))
    const appended = tracker.observe(input([
      system,
      user,
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'next' },
      control,
    ], [control]))
    const changedControl: ModelItem = { role: 'system', content: 'changed control' }
    const changedTail = tracker.observe(input([
      system,
      user,
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'next' },
      changedControl,
    ], [changedControl]))

    expect(appended.projectionDiagnostics).toMatchObject({
      transition: 'fact_appended',
      previousItems: 3,
      currentItems: 5,
      previousFactItems: 2,
      currentFactItems: 4,
      commonPrefixItems: 2,
      factCommonPrefixItems: 2,
      firstChangedItemIndex: 2,
      previousItemRole: 'system',
      currentItemRole: 'assistant',
      dynamicControlsChanged: false,
    })
    expect(changedTail.projectionDiagnostics).toMatchObject({
      transition: 'dynamic_tail_changed',
      firstChangedItemIndex: 4,
      previousItemRole: 'system',
      currentItemRole: 'system',
      dynamicControlsChanged: true,
    })
    expect(contextProjectionTraceAttrs(changedTail)).toMatchObject({
      cache_projection_transition: 'dynamic_tail_changed',
      cache_projection_first_changed_item_index: 4,
      cache_projection_dynamic_controls_changed: true,
    })
  })
})
