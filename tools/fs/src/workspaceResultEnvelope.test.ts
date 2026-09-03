import { describe, expect, it } from 'vitest'
import {
  isWorkspaceResultEnvelope,
  unwrapWorkspaceResult,
  workspaceResultToToolResult,
} from './workspaceResultEnvelope'

describe('workspace result envelope compatibility', () => {
  it('旧直接结果与新 success envelope 解出相同 data', () => {
    const data = { entries: [{ path: 'a.ts', type: 'file' }], truncated: false }

    expect(unwrapWorkspaceResult(data)).toBe(data)
    expect(unwrapWorkspaceResult({ ok: true, data })).toBe(data)
    expect(workspaceResultToToolResult(data, 'LIST_FAILED')).toEqual({ ok: true, data })
    expect(workspaceResultToToolResult({ ok: true, data }, 'LIST_FAILED')).toEqual({ ok: true, data })
  })

  it('failure envelope 在 throw 与 ToolResult 边界保留原文案', () => {
    const failure = { ok: false as const, error: 'outside workspace' }

    expect(() => unwrapWorkspaceResult(failure)).toThrow('outside workspace')
    expect(workspaceResultToToolResult(failure, 'READ_FAILED')).toEqual({
      ok: false,
      error: 'outside workspace',
      code: 'READ_FAILED',
      retryable: false,
    })
  })

  it.each([null, [], { ok: 'yes' }, { data: 1 }])('不把 %j 误认成 envelope', (value) => {
    expect(isWorkspaceResultEnvelope(value)).toBe(false)
  })
})
