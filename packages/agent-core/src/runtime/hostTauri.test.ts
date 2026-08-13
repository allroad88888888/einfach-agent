// hostTauri 的 colocated 测试（D1）。探针手法照抄 index.smoke.test.ts 的 load-count 姿势：
// vi.mock 的工厂是惰性的，只在该模块真的被 import 时才跑，工厂本身就是一个"是否被加载"的探针。
import { afterEach, describe, expect, it, vi } from 'vitest'

const loads = vi.hoisted(() => ({ core: 0 }))

vi.mock('@tauri-apps/api/core', () => {
  loads.core += 1
  return { invoke: vi.fn(async (command: string) => `mock:${command}`) }
})

import { isTauriHost, loadTauriInvoke } from './hostTauri'

type GlobalWithIsTauri = typeof globalThis & { isTauri?: boolean }
const globalWithIsTauri = globalThis as GlobalWithIsTauri
const hadIsTauriProperty = Object.prototype.hasOwnProperty.call(globalThis, 'isTauri')
const originalIsTauriValue = globalWithIsTauri.isTauri

describe('isTauriHost()：只做全局量读取，不触发模块加载', () => {
  afterEach(() => {
    // 恢复现场：不管测试里怎么改 globalThis.isTauri，都还原到本文件加载时的原始状态。
    if (hadIsTauriProperty) globalWithIsTauri.isTauri = originalIsTauriValue
    else delete globalWithIsTauri.isTauri
  })

  it('globalThis.isTauri 为 true 时返回 true', () => {
    globalWithIsTauri.isTauri = true
    expect(isTauriHost()).toBe(true)
  })

  it('globalThis.isTauri 为 false 时返回 false', () => {
    globalWithIsTauri.isTauri = false
    expect(isTauriHost()).toBe(false)
  })

  it('globalThis.isTauri 被删除（未定义）时返回 false', () => {
    delete globalWithIsTauri.isTauri
    expect(isTauriHost()).toBe(false)
  })

  it('只探测不触发 @tauri-apps/api/core 加载（此断言必须在本文件第一次调用 loadTauriInvoke 之前跑）', () => {
    isTauriHost()
    expect(loads.core).toBe(0)
  })
})

describe('loadTauriInvoke()：惰性加载 + module promise 缓存', () => {
  // 三个用例依赖 vitest 默认的声明顺序串行执行，且都在同一个 worker 模块实例里共享
  // hostTauri.ts 的 tauriCoreModule 缓存——第一条就是全文件里第一次触碰 loadTauriInvoke，
  // 借由 Promise.all 的同步求值特性（两次调用在同一个宏任务内发起）覆盖"同 tick 并发首调"。
  it('同 tick 并发两次首调只加载一次', async () => {
    const [first, second] = await Promise.all([loadTauriInvoke(), loadTauriInvoke()])
    expect(loads.core).toBe(1)
    expect(first).toBe(second) // 缓存命中：两次拿到的是同一个 invoke 引用
  })

  it('加载后再次调用不重复加载（promise 缓存）', async () => {
    await loadTauriInvoke()
    expect(loads.core).toBe(1)
  })

  it('取到的 invoke 可调用（mock 实现）', async () => {
    const invoke = await loadTauriInvoke()
    await expect(invoke('ping')).resolves.toBe('mock:ping')
    expect(loads.core).toBe(1)
  })
})
