import { describe, expect, it } from 'vitest'
import {
  checkApiVersionCompatibility,
  compareApiVersion,
  formatApiVersion,
  isApiVersionCompatible,
  parseApiVersionTriple,
} from './apiVersion'
import type { PluginManifest } from './manifestTypes'

function manifestWith(apiVersion: string): PluginManifest {
  return {
    id: 'acme.hello',
    name: 'Hello 插件',
    version: '1.0.0',
    apiVersion,
    capabilities: ['hooks'],
    entry: { core: 'core.js' },
    requestsTimelinePersist: false,
  }
}

describe('parseApiVersionTriple', () => {
  it.each([
    ['1', [1, 0, 0]],
    ['1.2', [1, 2, 0]],
    ['1.2.3', [1, 2, 3]],
    ['0', [0, 0, 0]],
    [' 2.0.1 ', [2, 0, 1]],
  ])('解析 %s', (raw, expected) => {
    expect(parseApiVersionTriple(raw)).toEqual(expected)
  })

  it.each([['v1'], ['1.2.3.4'], ['01'], ['1.2.3-beta'], [''], ['   '], ['10000'], [null], [42], [{}]])(
    '拒绝 %s',
    (raw: unknown) => {
      expect(parseApiVersionTriple(raw)).toBeUndefined()
    },
  )

  it('格式化回 x.y.z', () => {
    expect(formatApiVersion([1, 0, 0])).toBe('1.0.0')
  })

  it('按段比较，不做字典序', () => {
    expect(compareApiVersion([1, 10, 0], [1, 9, 9])).toBeGreaterThan(0)
    expect(compareApiVersion([1, 2, 3], [1, 2, 3])).toBe(0)
    expect(compareApiVersion([0, 9, 0], [1, 0, 0])).toBeLessThan(0)
  })
})

describe('checkApiVersionCompatibility', () => {
  const hostRange = { min: '1.0.0', max: '2.0.0' }

  it.each([['1.0.0'], ['1.5.0'], ['2.0.0']])('区间内的 %s 兼容（闭区间）', (apiVersion) => {
    expect(checkApiVersionCompatibility(manifestWith(apiVersion), hostRange)).toEqual({
      compatible: true,
    })
    expect(isApiVersionCompatible(manifestWith(apiVersion), hostRange)).toBe(true)
  })

  it.each([['0.9.9'], ['2.0.1'], ['3.0.0']])('区间外的 %s 判为 incompatible', (apiVersion) => {
    const result = checkApiVersionCompatibility(manifestWith(apiVersion), hostRange)

    expect(result.compatible).toBe(false)
    if (result.compatible) throw new Error('unreachable')
    expect(result.diagnostic.code).toBe('api_version_incompatible')
    expect(result.diagnostic.field).toBe('apiVersion')
    expect(result.diagnostic.message).toContain('1.0.0 – 2.0.0')
  })

  it('宿主区间可以只覆盖一个版本', () => {
    const exact = { min: '1.0.0', max: '1.0.0' }
    expect(isApiVersionCompatible(manifestWith('1.0.0'), exact)).toBe(true)
    expect(isApiVersionCompatible(manifestWith('1.0.1'), exact)).toBe(false)
  })

  it('宿主区间本身不合法时报 host_range_invalid 而不是抛异常', () => {
    for (const range of [{ min: '2.0.0', max: '1.0.0' }, { min: 'x', max: '2.0.0' }, { min: '1', max: '' }]) {
      const result = checkApiVersionCompatibility(manifestWith('1.0.0'), range)
      expect(result.compatible).toBe(false)
      if (result.compatible) throw new Error('unreachable')
      expect(result.diagnostic.code).toBe('host_range_invalid')
    }
  })

  it('manifest 的 apiVersion 无法解析时报 invalid_api_version', () => {
    const result = checkApiVersionCompatibility(manifestWith('nightly'), hostRange)

    expect(result.compatible).toBe(false)
    if (result.compatible) throw new Error('unreachable')
    expect(result.diagnostic.code).toBe('invalid_api_version')
  })
})
