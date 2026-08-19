// 契约模块桥（P11）：宿主手里的模块实例 → 可被 blob 插件 import 的模块 URL。
//
// jsdom 不求值 blob 模块，所以这里钉的是「生成的源码长什么样、全局交接放没放对、同一说明符
// 是不是只造一次」——真正跑一遍生成源码的用例在 desktopImportModule.bridge.test.ts。

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildContractModuleSource,
  CONTRACT_MODULE_GLOBAL_KEY,
  createContractModuleBridge,
  DEFAULT_CONTRACT_MODULES,
} from './contractModuleBridge'

function stubObjectUrls(): { blobs: Map<string, Blob> } {
  const blobs = new Map<string, Blob>()
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:test/${blobs.size}`
    blobs.set(url, blob as Blob)
    return url
  })
  return { blobs }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildContractModuleSource', () => {
  it('把每个导出名重新导出一遍，且从全局交接表里取命名空间', () => {
    const source = buildContractModuleSource('@einfach-agent/core/plugin', 'tok#1', ['definePlugin', 'default'])

    expect(source).toContain(`globalThis[${JSON.stringify(CONTRACT_MODULE_GLOBAL_KEY)}]`)
    expect(source).toContain('const __x0 = ns["definePlugin"]')
    // default 与保留字导出名都走 `local as name`，不必为它们分叉出第二种写法。
    expect(source).toContain('export { __x0 as definePlugin, __x1 as default }')
  })

  it('命名空间没挂上时抛出可读错误，而不是产出一个 undefined 到处传的模块', () => {
    expect(buildContractModuleSource('@einfach-agent/core/plugin', 'tok#1', ['definePlugin']))
      .toContain('未在宿主注册')
  })

  it('非标识符导出名不桥接（ES2022 字符串导出名不在契约模块里出现）', () => {
    const source = buildContractModuleSource('x', 'tok#1', ['ok', 'not-an-identifier'])
    expect(source).toContain('export { __x0 as ok }')
    expect(source).not.toContain('not-an-identifier')
  })
})

describe('createContractModuleBridge', () => {
  it('把注入的命名空间挂到全局交接表，生成的源码按那个 token 取回来', () => {
    const { blobs } = stubObjectUrls()
    const namespace = { definePlugin: () => 'plugin' }
    const bridge = createContractModuleBridge({ modules: { 'x/contract': namespace } })

    expect(bridge.specifiers).toEqual(['x/contract'])
    const url = bridge.urlFor('x/contract')

    const registry = (globalThis as unknown as Record<string, Record<string, object>>)[
      CONTRACT_MODULE_GLOBAL_KEY
    ]
    const token = Object.keys(registry).find((key) => registry[key] === namespace)
    expect(token).toBeDefined()
    expect(blobs.has(url)).toBe(true)
  })

  it('同一说明符只造一次模块：插件之间必须共享同一份实例（品牌才对得上）', () => {
    stubObjectUrls()
    const bridge = createContractModuleBridge({ modules: { 'x/contract': { a: 1 } } })

    expect(bridge.urlFor('x/contract')).toBe(bridge.urlFor('x/contract'))
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('问一个没注册的说明符：如实报错，不造一个求值即崩的模块', () => {
    stubObjectUrls()
    const bridge = createContractModuleBridge({ modules: { 'x/contract': { a: 1 } } })
    expect(() => bridge.urlFor('y/other')).toThrow(/没有注册/)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('默认只桥 core 公开入口，且它确实带着 definePlugin', () => {
    expect(Object.keys(DEFAULT_CONTRACT_MODULES)).toEqual(['@einfach-agent/core/plugin'])
    expect(DEFAULT_CONTRACT_MODULES['@einfach-agent/core/plugin']).toHaveProperty('definePlugin')
  })
})
