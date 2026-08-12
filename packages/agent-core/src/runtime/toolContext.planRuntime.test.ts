import { describe, expect, it } from 'vitest'
import { createCoreInstance } from './core/coreInstance'
import { buildToolContext } from './toolContext'

describe('ToolContext 的 planRuntime 槽', () => {
  it('未注入时不暴露计划工具能力', () => {
    const ctx = buildToolContext({
      sessionId: 'session-1',
      runId: 'run-1',
      signal: new AbortController().signal,
      callId: 'call-1',
      toolName: 'create_plan',
      core: createCoreInstance({ planRuntime: null }),
    })

    expect(ctx.getPlan).toBeUndefined()
    expect(ctx.createPlan).toBeUndefined()
    expect(ctx.executePlan).toBeUndefined()
    expect(ctx.updatePlan).toBeUndefined()
    expect(ctx.submitStageResult).toBeUndefined()
  })
})
