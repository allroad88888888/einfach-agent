import { describe, expect, it } from 'vitest'
import { definePlugin } from '../runtime/core/pluginContracts'
import { resolveCorePluginExport } from './pluginModuleExports'

describe('resolveCorePluginExport', () => {
  it('接受默认导出的 branded 插件', () => {
    const plugin = definePlugin({ install() {} })
    const result = resolveCorePluginExport({ default: plugin })
    expect(result).toEqual({ ok: true, plugin, exportName: 'default' })
  })

  it('接受具名 corePlugin 导出', () => {
    const plugin = definePlugin({ install() {} })
    const result = resolveCorePluginExport({ corePlugin: plugin })
    expect(result.ok && result.exportName).toBe('corePlugin')
  })

  it('默认导出不合规时回落到具名 corePlugin', () => {
    const plugin = definePlugin({ install() {} })
    const result = resolveCorePluginExport({ default: { install() {} }, corePlugin: plugin })
    expect(result.ok && result.plugin).toBe(plugin)
  })

  it('另一份 core 实例造的插件也认：品牌是全局注册表 Symbol，不是模块局部 Symbol', () => {
    // 模拟插件经别的解析路径（CLI 的 node_modules、桌面的说明符改写、将来 npm 上装了第二份）
    // 拿到另一份 definePlugin：实现不同，但打的是同一个 Symbol.for 品牌。
    const foreign = Object.freeze({
      install() {},
      [Symbol.for('web-agent.public-plugin')]: true as const,
    })
    const result = resolveCorePluginExport({ default: foreign })
    expect(result.ok).toBe(true)
  })

  it('definePlugin 打的就是那个全局品牌（改名会让上一条静默失效，这里钉住）', () => {
    const plugin = definePlugin({ install() {} }) as unknown as Record<symbol, unknown>
    expect(plugin[Symbol.for('web-agent.public-plugin')]).toBe(true)
  })

  it('裸对象一律拒绝', () => {
    const result = resolveCorePluginExport({ default: { install() {} } })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('definePlugin')
  })

  it('函数导出也拒绝（旧内部插件形状不能冒充公开插件）', () => {
    const result = resolveCorePluginExport({ default: () => {} })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('definePlugin')
  })

  it('缺少两种导出时说清缺什么', () => {
    const result = resolveCorePluginExport({ other: 1 })
    expect(!result.ok && result.reason).toContain('corePlugin')
  })

  it('非对象模块被拒绝且不抛异常', () => {
    expect(resolveCorePluginExport(undefined).ok).toBe(false)
    expect(resolveCorePluginExport(null).ok).toBe(false)
    expect(!resolveCorePluginExport('nope').ok).toBe(true)
    const result = resolveCorePluginExport(42)
    expect(!result.ok && result.reason).toContain('number')
  })
})
