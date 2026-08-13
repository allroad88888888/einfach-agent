// apps/web/src/plugins/toggleStorage.test.ts —— 启停/勾选记录的存储形状与兼容
// ---------------------------------------------------------------------------
// 重点：v2 记录（disabled + tools）的往返，以及读 v1 旧记录（只有 disabled）不丢启停、
// 勾选按默认关兜住。

import { beforeEach, describe, expect, it } from 'vitest'
import {
  PLUGIN_TOGGLES_STORAGE_KEY,
  createLocalStoragePluginToggleStorage,
  createMemoryPluginToggleStorage,
} from './toggleStorage'

class FakeStorage {
  readonly entries = new Map<string, string>()
  failWrites = false

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('quota exceeded')
    this.entries.set(key, value)
  }
}

describe('createLocalStoragePluginToggleStorage', () => {
  let backing: FakeStorage

  beforeEach(() => {
    backing = new FakeStorage()
  })

  it('往返一份含逐工具勾选的记录', () => {
    const storage = createLocalStoragePluginToggleStorage(backing)

    storage.save({
      disabled: { 'com.example.off': true },
      tools: { 'com.example.tools': { plugin_tool_a: true } },
    })

    expect(createLocalStoragePluginToggleStorage(backing).load()).toEqual({
      disabled: { 'com.example.off': true },
      tools: { 'com.example.tools': { plugin_tool_a: true } },
    })
    const persisted: unknown = JSON.parse(backing.entries.get(PLUGIN_TOGGLES_STORAGE_KEY) ?? '')
    expect(persisted).toMatchObject({ version: 2 })
  })

  it('读得懂 P5 的旧记录形状（只有 disabled，没有 tools）', () => {
    // P5 落盘的 v1 envelope 字面量：升级后启停记录必须原样留着，勾选按默认关兜底。
    backing.entries.set(
      PLUGIN_TOGGLES_STORAGE_KEY,
      JSON.stringify({ version: 1, disabled: { 'com.example.legacy': true } }),
    )

    const storage = createLocalStoragePluginToggleStorage(backing)

    expect(storage.load()).toEqual({ disabled: { 'com.example.legacy': true }, tools: {} })

    // 下一次 save 自然升到 v2，不需要独立的迁移步骤。
    storage.save({ ...storage.load(), tools: { 'com.example.legacy': { t: true } } })
    expect(storage.load()).toEqual({
      disabled: { 'com.example.legacy': true },
      tools: { 'com.example.legacy': { t: true } },
    })
  })

  it('损坏或非对象的记录读成空态而不是抛异常', () => {
    backing.entries.set(PLUGIN_TOGGLES_STORAGE_KEY, '{not json')
    expect(createLocalStoragePluginToggleStorage(backing).load()).toEqual({ disabled: {}, tools: {} })

    backing.entries.set(PLUGIN_TOGGLES_STORAGE_KEY, '"nope"')
    expect(createLocalStoragePluginToggleStorage(backing).load()).toEqual({ disabled: {}, tools: {} })
  })

  it('写不进去时静默降级，不打断当前这次勾选', () => {
    const storage = createLocalStoragePluginToggleStorage(backing)
    backing.failWrites = true

    expect(() => storage.save({ disabled: {}, tools: { a: { b: true } } })).not.toThrow()
  })
})

describe('createMemoryPluginToggleStorage', () => {
  it('只保留 true 项，非法/取消的条目一律丢弃', () => {
    const storage = createMemoryPluginToggleStorage({
      disabled: { good: true, stale: false } as Record<string, boolean>,
      tools: { 'com.example': { on: true, off: false }, 'com.empty': {} },
    })

    expect(storage.load()).toEqual({
      disabled: { good: true },
      tools: { 'com.example': { on: true } },
    })
  })

  it('默认构造得到一份空记录（默认全关）', () => {
    expect(createMemoryPluginToggleStorage().load()).toEqual({ disabled: {}, tools: {} })
  })
})
