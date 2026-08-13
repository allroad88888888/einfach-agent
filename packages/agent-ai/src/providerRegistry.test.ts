import { describe, expect, it } from 'vitest'
import { createProviderRegistry, type ProviderAdapter, type VendorDescriptor } from './providerRegistry'

const stubDescriptor: VendorDescriptor = { contextWindowTokens: 1, maxTurnTools: 1, models: {} }

function stubAdapter(label: string): ProviderAdapter {
  return {
    descriptor: stubDescriptor,
    call: async () => ({ id: `${label}:call` }),
    stream: async () => ({ id: `${label}:stream` }),
  }
}

describe('provider registry', () => {
  it('解析已注册的 vendorId', () => {
    const registry = createProviderRegistry()
    const adapter = stubAdapter('a')

    registry.register('a', adapter)

    expect(registry.resolve('a')).toBe(adapter)
  })

  it('没有 fallback 时未知 vendorId 解析为 undefined', () => {
    const registry = createProviderRegistry()
    registry.register('a', stubAdapter('a'))

    expect(registry.resolve('unknown')).toBeUndefined()
  })

  it('未知 vendorId 回退到 fallbackVendorId 的 adapter', () => {
    const registry = createProviderRegistry({ fallbackVendorId: 'a' })
    const fallback = stubAdapter('a')
    registry.register('a', fallback)
    registry.register('b', stubAdapter('b'))

    expect(registry.resolve('unknown')).toBe(fallback)
    // 回退只对未注册的 vendorId 生效，已注册的仍走自己的 adapter。
    expect(registry.resolve('b')).not.toBe(fallback)
  })

  it('fallback 目标本身未注册时仍解析为 undefined', () => {
    const registry = createProviderRegistry({ fallbackVendorId: 'a' })

    expect(registry.resolve('unknown')).toBeUndefined()
  })

  it('重复注册以最后一次为准', () => {
    const registry = createProviderRegistry()
    const first = stubAdapter('first')
    const second = stubAdapter('second')

    registry.register('a', first)
    registry.register('a', second)

    expect(registry.resolve('a')).toBe(second)
  })

  it('实例之间互不共享注册表', () => {
    const registry = createProviderRegistry()
    const other = createProviderRegistry()
    registry.register('a', stubAdapter('a'))

    expect(other.resolve('a')).toBeUndefined()
  })

  it('adapter 拿到通用请求体与未归一的 settings', async () => {
    const registry = createProviderRegistry()
    const seen: unknown[] = []
    registry.register('a', {
      descriptor: stubDescriptor,
      call: async (request) => {
        seen.push(request)
        return {}
      },
      stream: async (request, _options, _handlers, retryObserver) => {
        seen.push({ request, hasObserver: retryObserver !== undefined })
        return {}
      },
    })

    const adapter = registry.resolve('a')
    const request = {
      body: { model: 'm', messages: [] },
      settings: { vendor: 'a', region: 'cn' },
      userId: 'wa_child_0123',
    }
    await adapter?.call(request, { apiKey: 'k' })
    await adapter?.stream(request, { apiKey: 'k' }, undefined, { onRetry: () => {} })

    expect(seen[0]).toEqual(request)
    expect(seen[1]).toEqual({ request, hasObserver: true })
  })

  it('describe 返回已注册 vendorId 的 descriptor', () => {
    const registry = createProviderRegistry()
    const descriptor: VendorDescriptor = { contextWindowTokens: 999, maxTurnTools: 7, models: {} }
    registry.register('a', { ...stubAdapter('a'), descriptor })

    expect(registry.describe('a')).toBe(descriptor)
  })

  it('describe 对未注册 vendorId 使用保守默认值，不复用 resolve 的 fallbackVendorId', () => {
    const registry = createProviderRegistry({ fallbackVendorId: 'a' })
    const fallbackDescriptor: VendorDescriptor = {
      contextWindowTokens: 999,
      maxTurnTools: 7,
      models: { 'a-model': { contextWindowTokens: 5, imageInput: { kind: 'unsupported', reason: 'x' } } },
    }
    registry.register('a', { ...stubAdapter('a'), descriptor: fallbackDescriptor })

    // resolve 会把未知 vendorId 兜到 'a' 的 adapter，但 describe 不应该跟着继承 'a' 的模型清单。
    expect(registry.resolve('unknown')).toBe(registry.resolve('a'))
    expect(registry.describe('unknown')).not.toBe(fallbackDescriptor)
    expect(registry.describe('unknown')).toEqual({ contextWindowTokens: 64_000, maxTurnTools: 128, models: {} })
  })
})
