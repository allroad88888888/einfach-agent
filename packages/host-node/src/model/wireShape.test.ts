import { describe, expect, it } from 'vitest'
import { narrowProviderRequestBody } from './requestBody'
import { narrowProviderRequestEnvelope } from './requestEnvelope'
import { narrowProviderTarget } from './providerRoute'
import { definedKeys, hasExactKeys, isJsonRecord } from './wireShape'

describe('形状判据', () => {
  it('isJsonRecord 只收纯对象', () => {
    expect(isJsonRecord({})).toBe(true)
    for (const value of [null, undefined, [], 'x', 1, true]) expect(isJsonRecord(value)).toBe(false)
  })

  it('definedKeys / hasExactKeys 把值为 undefined 的键当作没写', () => {
    expect(definedKeys({ a: 1, b: undefined })).toEqual(['a'])
    expect(hasExactKeys({ a: 1, b: undefined }, ['a'])).toBe(true)
    expect(hasExactKeys({ a: 1, b: 2 }, ['a'])).toBe(false)
    expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false)
  })
})

describe('两种传输下同一份入参必须得到同一个答案', () => {
  // 进程内注入（CLI / sidecar）时可选项以「键存在且为 undefined」到达；走 HTTP 时
  // `JSON.stringify` 把那个键整个丢掉。按裸 `Object.keys` 判多余字段，同一份入参会一边被拒
  // 一边被收——那正是「本地能跑、上 server 就变」的那类 bug。
  const withUndefined = {
    target: {
      provider: 'deepseek',
      scope: undefined,
      method: 'POST',
      path: '/chat/completions',
    },
    body: { kind: 'json', json: '{}' },
    requestId: 'request-1',
    // 顶层的可选项同理（本命令当前没有可选顶层键，这里用一个显式 undefined 模拟）。
    extra: undefined,
  }
  const overHttp: unknown = JSON.parse(JSON.stringify(withUndefined))

  it('信封、target、body 三处收窄的结果逐字相同', () => {
    expect(narrowProviderRequestEnvelope(withUndefined)).toEqual(
      narrowProviderRequestEnvelope(overHttp),
    )
    expect(narrowProviderTarget(withUndefined.target)).toEqual({
      provider: 'deepseek',
      scope: 'default',
      method: 'POST',
      path: '/chat/completions',
    })
    expect(narrowProviderRequestBody({ kind: 'json', json: '{}', parts: undefined })).toEqual({
      kind: 'json',
      json: '{}',
    })
  })

  it('带值的多余字段照旧被拒——放行 undefined 不削弱 deny_unknown_fields', () => {
    // JSON 里表达不出 undefined，所以攻击者塞进来的键必然带值。
    expect(() => narrowProviderRequestEnvelope({ ...withUndefined, extra: 1 })).toThrow(
      '模型请求格式无效',
    )
    expect(() =>
      narrowProviderTarget({ ...withUndefined.target, url: 'https://evil.test' }),
    ).toThrow('模型请求格式无效')
  })
})
