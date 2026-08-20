// 本域失败的两个面：给人看的文案（跨宿主契约，逐字钉住）与给机器看的 `reason`（判别面）。
import { describe, expect, it } from 'vitest'
import {
  MODEL_ERROR,
  MODEL_REQUEST_ERROR_REASONS,
  missingCredentialError,
  ModelProxyStreamError,
  ModelRequestCancelledError,
  modelRequestError,
  readModelRequestErrorReason,
  type ModelErrorKey,
  type ModelRequestErrorReason,
} from './errors'
import { credentialConfigKey } from './credentials'
import { narrowProviderRequestEnvelope } from './requestEnvelope'
import { createModelRequestRegistry, validateModelRequestId } from './requestRegistry'
import { resolveProviderTarget } from './providerRoute'

/** 每条文案的分类。表在这里**再写一遍**是有意的：它是判据，不是实现的回声。 */
const EXPECTED: Record<ModelErrorKey, { message: string; reason: ModelRequestErrorReason }> = {
  invalidRequest: { message: '模型请求格式无效', reason: 'invalid-request' },
  targetNotAllowed: { message: '模型请求目标未获允许', reason: 'target-not-allowed' },
  invalidRequestId: { message: '模型请求 ID 无效', reason: 'invalid-request' },
  duplicateRequestId: { message: '模型请求 ID 已存在', reason: 'duplicate-request-id' },
  responseTooLarge: { message: '模型响应过大', reason: 'upstream-failed' },
  responseInterrupted: { message: '模型响应中断', reason: 'upstream-failed' },
  upstreamFailed: { message: '模型服务请求失败', reason: 'upstream-failed' },
  scopeNotAllowed: { message: '模型凭证作用域未获允许', reason: 'target-not-allowed' },
  invalidApiKey: { message: '模型 API Key 格式无效', reason: 'invalid-request' },
  invalidConfigFormat: { message: '模型配置文件格式无效', reason: 'credential-config-invalid' },
  invalidBaseUrl: { message: '模型接入点地址未获允许', reason: 'target-not-allowed' },
}

describe('文案是跨宿主契约，逐字钉住', () => {
  // 加 `reason` **不是**改文案的借口：同一个前端在桌面宿主与 Node 宿主下必须看到同一句话。
  // 这条用例的作用是让「顺手改一下措辞」变成一次自觉的动作——改文案要连着改 Rust 侧。
  it.each(Object.keys(EXPECTED) as ModelErrorKey[])('%s', (key) => {
    expect(MODEL_ERROR[key]).toBe(EXPECTED[key].message)
  })

  it('表里没有多出来的键——新增一条却忘了在这里登记，这条会红', () => {
    expect(Object.keys(MODEL_ERROR).sort()).toEqual(Object.keys(EXPECTED).sort())
  })
})

describe('每条文案的分类', () => {
  it.each(Object.keys(EXPECTED) as ModelErrorKey[])('%s 带上正确的 reason', (key) => {
    const error = modelRequestError(key)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe(EXPECTED[key].message)
    expect(error.reason).toBe(EXPECTED[key].reason)
  })

  it('用到的 reason 全在闭合枚举里，枚举里也没有一条是死的', () => {
    const used = new Set<string>(Object.values(EXPECTED).map((entry) => entry.reason))
    // 取消、以及 missingCredential 不走 MODEL_ERROR 表，各自补上。
    used.add(new ModelRequestCancelledError().reason)
    used.add(missingCredentialError('DeepSeek').reason)
    expect([...used].sort()).toEqual([...MODEL_REQUEST_ERROR_REASONS].sort())
  })

  it('没配 Key 是自己一类，文案里只有展示名', () => {
    const error = missingCredentialError('DeepSeek')
    expect(error.reason).toBe('credential-missing')
    expect(error.message).toBe('未配置 DeepSeek API Key')
  })

  it('流错误恒为 upstream-failed；「响应头有没有交出去」不进 reason', () => {
    // 那不是失败的种类而是发生的时刻，外壳判它用的是 `response.headersSent`。
    expect(new ModelProxyStreamError(MODEL_ERROR.responseInterrupted).reason).toBe('upstream-failed')
    expect(new ModelProxyStreamError(MODEL_ERROR.responseTooLarge).reason).toBe('upstream-failed')
    expect(new ModelProxyStreamError('x').name).toBe('ModelProxyStreamError')
  })

  it('取消是自己一类', () => {
    const error = new ModelRequestCancelledError()
    expect(error.reason).toBe('cancelled')
    expect(error.name).toBe('ModelRequestCancelledError')
    expect(error.message).toBe('模型请求已取消')
  })
})

describe('readModelRequestErrorReason 只看字段，不看类型身份', () => {
  it('跨一次 JSON 往返仍然认得出——这就是它不用 instanceof 的全部理由', () => {
    // sidecar / HTTP 那条路上到达的是一袋 JSON：原型没了，`instanceof` 全部落空，只有字段还在。
    // 展开的是错误对象**自己的可枚举属性**，没有补写任何字段——`reason` 必须是真的能被序列化
    // 带过去的那种属性，写成 getter 或 Symbol 都会让这条红。
    const wire: unknown = JSON.parse(JSON.stringify({ ...modelRequestError('targetNotAllowed') }))
    expect(readModelRequestErrorReason(wire)).toBe('target-not-allowed')
    expect(wire).not.toBeInstanceOf(Error)
  })

  it('裸对象也认', () => {
    expect(readModelRequestErrorReason({ reason: 'credential-missing' })).toBe('credential-missing')
  })

  it('不认识的形状一律 undefined，不硬塞进某一类', () => {
    expect(readModelRequestErrorReason(new Error('模型服务请求失败'))).toBeUndefined()
    expect(readModelRequestErrorReason({ reason: 'made-up' })).toBeUndefined()
    expect(readModelRequestErrorReason({ reason: 42 })).toBeUndefined()
    expect(readModelRequestErrorReason(null)).toBeUndefined()
    expect(readModelRequestErrorReason('模型请求格式无效')).toBeUndefined()
    expect(readModelRequestErrorReason(undefined)).toBeUndefined()
  })
})

describe('抛出点真的带上了 reason', () => {
  /** 抛出点的错误对象——不是「有没有抛」，是「抛出来的那个东西带没带分类」。 */
  function thrownFrom(work: () => unknown): unknown {
    try {
      work()
    } catch (error) {
      return error
    }
    throw new Error('预期失败，却成功了')
  }

  it('信封收窄 → invalid-request', () => {
    const error = thrownFrom(() => narrowProviderRequestEnvelope({ nope: 1 }))
    expect(readModelRequestErrorReason(error)).toBe('invalid-request')
  })

  it('requestId 格式 → invalid-request', () => {
    expect(readModelRequestErrorReason(thrownFrom(() => validateModelRequestId('bad id'))))
      .toBe('invalid-request')
  })

  it('requestId 撞上在飞的那一次 → duplicate-request-id，与格式无效分得开', () => {
    const registry = createModelRequestRegistry()
    registry.register('dup-1')
    expect(readModelRequestErrorReason(thrownFrom(() => registry.register('dup-1'))))
      .toBe('duplicate-request-id')
  })

  it('白名单外的目标 → target-not-allowed', () => {
    const error = thrownFrom(() => resolveProviderTarget({
      provider: 'deepseek',
      scope: 'default',
      method: 'POST',
      path: '/v1/anything',
    }))
    expect(readModelRequestErrorReason(error)).toBe('target-not-allowed')
  })

  it('凭证作用域配对失败 → 同样是 target-not-allowed（同一张配对表、同一个补救）', () => {
    expect(readModelRequestErrorReason(thrownFrom(() => credentialConfigKey('kimi', 'default'))))
      .toBe('target-not-allowed')
  })
})
