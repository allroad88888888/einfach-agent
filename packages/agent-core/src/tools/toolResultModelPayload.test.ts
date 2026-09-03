import { describe, expect, it } from 'vitest'
import { serializeToolResultForModel } from './toolResultModelPayload'

describe('serializeToolResultForModel', () => {
  it.each([
    [{ ok: true as const }, { ok: true }],
    [{ ok: true as const, data: null }, { ok: true }],
    [{ ok: true as const, data: { value: 1 } }, { value: 1 }],
    [
      { ok: true as const, data: ['a'], warnings: ['maxEntries clamped'] },
      { data: ['a'], warnings: ['maxEntries clamped'] },
    ],
  ])('成功结果投影为 %j', (result, expected) => {
    expect(JSON.parse(serializeToolResultForModel(result, 'pause'))).toEqual(expected)
  })

  it('失败结果保留可选诊断，并保留 false 与 null', () => {
    const result = {
      ok: false as const,
      error: 'failed',
      code: 'E_FAIL',
      hint: 'retry later',
      retryable: false,
      details: null,
    }

    expect(JSON.parse(serializeToolResultForModel(result, 'pause'))).toEqual({
      error: 'failed', code: 'E_FAIL', hint: 'retry later', retryable: false, details: null,
    })
  })

  it('root 与 child wrapper 各自决定不可信 pause 的错误语义', () => {
    const pause = { pause: { questions: [] } }
    expect(JSON.parse(serializeToolResultForModel(pause, 'unexpected pause'))).toEqual({
      error: 'unexpected pause',
    })
    expect(JSON.parse(serializeToolResultForModel(pause, 'child tools cannot pause'))).toEqual({
      error: 'child tools cannot pause',
    })
  })
})
