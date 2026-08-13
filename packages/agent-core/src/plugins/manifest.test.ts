import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from './manifest'
import type { ManifestParseSuccess } from './manifestTypes'

/** 一份最小可用 manifest；各用例只覆盖自己关心的字段。 */
function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acme.hello',
    name: 'Hello 插件',
    version: '1.4.2',
    apiVersion: '1.0.0',
    capabilities: ['hooks'],
    entry: { core: 'core.js' },
    ...overrides,
  }
}

function expectOk(raw: unknown): ManifestParseSuccess {
  const result = parsePluginManifest(raw)
  if (!result.ok) {
    throw new Error(`预期解析成功，实际诊断：${JSON.stringify(result.diagnostics)}`)
  }
  return result
}

describe('parsePluginManifest 成功路径', () => {
  it('归一化出完整 manifest', () => {
    const { manifest, warnings } = expectOk(validManifest())

    expect(manifest).toEqual({
      id: 'acme.hello',
      name: 'Hello 插件',
      version: '1.4.2',
      apiVersion: '1.0.0',
      capabilities: ['hooks'],
      entry: { core: 'core.js' },
      requestsTimelinePersist: false,
    })
    expect(warnings).toEqual([])
  })

  it('trim 文本字段的首尾空白', () => {
    const { manifest } = expectOk(validManifest({ id: '  acme.hello  ', name: ' Hello ' }))

    expect(manifest.id).toBe('acme.hello')
    expect(manifest.name).toBe('Hello')
  })

  it.each([
    ['1', '1.0.0'],
    ['1.2', '1.2.0'],
    ['0.0.1', '0.0.1'],
    ['12.34.56', '12.34.56'],
  ])('把 apiVersion %s 归一化为 %s', (input, expected) => {
    expect(expectOk(validManifest({ apiVersion: input })).manifest.apiVersion).toBe(expected)
  })

  it('capabilities 去重并按枚举顺序稳定排序', () => {
    const { manifest } = expectOk(
      validManifest({ capabilities: ['renderer', 'hooks', 'tools', 'hooks', 'commands'] }),
    )

    expect(manifest.capabilities).toEqual(['tools', 'hooks', 'commands', 'renderer'])
  })

  it('接受空的 capabilities 数组', () => {
    expect(expectOk(validManifest({ capabilities: [] })).manifest.capabilities).toEqual([])
  })

  it.each([
    ['core.js', 'core.js'],
    ['./core.js', 'core.js'],
    ['dist/core.js', 'dist/core.js'],
    ['dist/esm/index.mjs', 'dist/esm/index.mjs'],
  ])('入口路径 %s 归一化为 %s', (input, expected) => {
    expect(expectOk(validManifest({ entry: { core: input } })).manifest.entry.core).toBe(expected)
  })

  it('core 与 react 分开声明，只有 react 也合法', () => {
    const onlyReact = expectOk(validManifest({ entry: { react: 'ui.js' } })).manifest
    expect(onlyReact.entry).toEqual({ react: 'ui.js' })

    const both = expectOk(validManifest({ entry: { core: 'core.js', react: 'ui.js' } })).manifest
    expect(both.entry).toEqual({ core: 'core.js', react: 'ui.js' })
  })

  it('忽略未知的顶层字段（为后续扩展留余地）', () => {
    const { manifest } = expectOk(validManifest({ futureField: { anything: true } }))
    expect(manifest.id).toBe('acme.hello')
  })

  it('version 只做展示校验，不要求 SemVer', () => {
    expect(expectOk(validManifest({ version: '2026.08.13-nightly+build.7' })).manifest.version)
      .toBe('2026.08.13-nightly+build.7')
  })
})

describe('timeline.persist 申报', () => {
  it('解析层允许申报，但单独标记并给出不可授予的警告', () => {
    const { manifest, warnings } = expectOk(
      validManifest({ capabilities: ['hooks', 'timeline.persist'] }),
    )

    expect(manifest.capabilities).toEqual(['hooks', 'timeline.persist'])
    expect(manifest.requestsTimelinePersist).toBe(true)
    expect(warnings).toEqual([
      {
        code: 'capability_not_grantable',
        field: 'capabilities',
        message: '插件申报了 `timeline.persist`，当前版本不会授予该能力',
      },
    ])
  })

  it('未申报时标记为 false 且没有警告', () => {
    const result = expectOk(validManifest())
    expect(result.manifest.requestsTimelinePersist).toBe(false)
    expect(result.warnings).toHaveLength(0)
  })
})
