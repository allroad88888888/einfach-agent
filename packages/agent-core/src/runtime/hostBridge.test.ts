// hostBridge 的 colocated 测试（H1）。钉的是契约的四个面：登记（同步）、解析（惰性 + 缓存）、
// 未登记时的明确失败、重新登记时缓存作废。
//
// 与 hostTauri.test.ts 的差别：那边用 `vi.mock` 工厂当「模块是否被加载」的探针，因为被测的是一次
// 真实的动态 import；这里 loader 是调用方注入的普通函数，计数直接由 loader 自己维护即可，不需要
// mocker 参与。反过来说，本文件的 beforeEach 必须把模块级单例还原干净 —— 同一个 worker 里所有
// 用例共享 hostBridge.ts 的那一份 loader/promise 缓存。
import { beforeEach, describe, expect, it } from 'vitest'

import { configureHostInvoke, hasHostBridge, loadHostInvoke, type HostInvoke } from './hostBridge'

/** 造一个可辨识的 invoke：返回值带上标签，便于断言「拿到的是哪一个桥」。 */
const makeInvoke = (label: string): HostInvoke =>
  (async (cmd: string) => `${label}:${cmd}`) as HostInvoke

/** 造一个记调用次数的 loader —— 「只解析一次」的全部断言都落在这个计数上。 */
function makeLoader(label: string) {
  const state = { calls: 0 }
  const loader = async () => {
    state.calls += 1
    return makeInvoke(label)
  }
  return { loader, state }
}

beforeEach(() => {
  // 还原模块级单例：不还原的话前一条用例登记的 loader 会漏进下一条，
  // 「未登记」那组用例就会随执行顺序时绿时红。
  configureHostInvoke(undefined)
})

describe('未登记 loader 时', () => {
  it('hasHostBridge() 为 false', () => {
    expect(hasHostBridge()).toBe(false)
  })

  it('loadHostInvoke() 以 rejection 明确失败，不返回兜底 invoke', async () => {
    await expect(loadHostInvoke()).rejects.toThrow(/configureHostInvoke/)
  })

  it('失败不是一次性的：仍未登记时反复调用都失败', async () => {
    await expect(loadHostInvoke()).rejects.toThrow()
    await expect(loadHostInvoke()).rejects.toThrow()
    expect(hasHostBridge()).toBe(false)
  })
})

describe('configureHostInvoke(loader)', () => {
  it('登记后 hasHostBridge() 立即为 true —— 同步可答，无需 await', () => {
    const { loader, state } = makeLoader('tauri')

    configureHostInvoke(loader)

    // 这两条断言合起来才是「收 loader 而不是收已解析 invoke」的意义所在：登记这一步是同步的，
    // 调用点的 hasHostBridge() 早退分支在装配返回的那一刻就已经切换，中间没有「已登记但还答
    // false」的窗口；而此时 loader 一次都还没跑，惰性也保住了。
    expect(hasHostBridge()).toBe(true)
    expect(state.calls).toBe(0)
  })

  it('传 undefined 重置回未登记', async () => {
    configureHostInvoke(makeLoader('tauri').loader)
    expect(hasHostBridge()).toBe(true)

    configureHostInvoke(undefined)

    expect(hasHostBridge()).toBe(false)
    await expect(loadHostInvoke()).rejects.toThrow(/configureHostInvoke/)
  })
})

describe('loadHostInvoke() 的解析与缓存', () => {
  it('解析出的 invoke 可调用', async () => {
    configureHostInvoke(makeLoader('tauri').loader)

    const invoke = await loadHostInvoke()

    await expect(invoke<string>('workspace_read', { path: 'a.ts' })).resolves.toBe(
      'tauri:workspace_read',
    )
  })

  it('连续多次调用复用同一次解析（loader 只跑一次）', async () => {
    const { loader, state } = makeLoader('tauri')
    configureHostInvoke(loader)

    const first = await loadHostInvoke()
    const second = await loadHostInvoke()
    const third = await loadHostInvoke()

    expect(state.calls).toBe(1)
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('同 tick 并发首调也只解析一次', async () => {
    // 这条是 `??=` 缓存存在的理由（hostTauri.ts 的同款记档：并发首次 import 时 Vitest 的 mocker
    // 有一路会拿到未替换的真模块）。用一个手动 defer 的 loader 把解析窗口撑开：三次调用都在
    // loader 还没 resolve 时发起，若缓存写在 await 之后就会漏成三次解析。
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const state = { calls: 0 }
    configureHostInvoke(async () => {
      state.calls += 1
      await gate
      return makeInvoke('tauri')
    })

    const pending = [loadHostInvoke(), loadHostInvoke(), loadHostInvoke()]
    expect(state.calls).toBe(1) // 三次调用已全部发起，loader 却只被触发了一次
    release?.()
    const [first, second, third] = await Promise.all(pending)

    expect(state.calls).toBe(1)
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('loader 失败不进缓存：下一次调用会重试', async () => {
    // 缓存住 rejected promise 会把一次偶发失败固化成「桥永久坏掉」，而没有任何调用点会去重新
    // configure。这里第一次让 loader 抛，第二次让它成功，成功即证明失败没被缓存住。
    const state = { calls: 0 }
    configureHostInvoke(async () => {
      state.calls += 1
      if (state.calls === 1) throw new Error('boom')
      return makeInvoke('retry')
    })

    await expect(loadHostInvoke()).rejects.toThrow('boom')
    await expect(loadHostInvoke().then((invoke) => invoke<string>('ping'))).resolves.toBe(
      'retry:ping',
    )
    expect(state.calls).toBe(2)
  })
})

describe('重新 configureHostInvoke 时', () => {
  it('拿到新 invoke，旧缓存不复活', async () => {
    const firstLoader = makeLoader('first')
    configureHostInvoke(firstLoader.loader)
    const before = await loadHostInvoke()
    await expect(before<string>('ping')).resolves.toBe('first:ping')

    const secondLoader = makeLoader('second')
    configureHostInvoke(secondLoader.loader)
    const after = await loadHostInvoke()

    expect(after).not.toBe(before)
    await expect(after<string>('ping')).resolves.toBe('second:ping')
    expect(secondLoader.state.calls).toBe(1)
    expect(firstLoader.state.calls).toBe(1) // 旧 loader 没有被再次触发
  })

  it('旧 loader 在换桥之后才失败，不会把新桥的缓存一并清掉', async () => {
    // 上一条「失败不进缓存」的清理动作前有一次 promise 身份比对，这条用例钉住它：慢的旧 loader
    // 在换桥之后才 reject，此刻缓存里躺着的已经是新桥的解析 —— 不比对身份就会被旧失败清空，
    // 表现为新桥被无端重解析一次（更远的宿主实现里，重解析可能意味着重新握手甚至重开连接）。
    let fail: ((error: Error) => void) | undefined
    const slow = new Promise<HostInvoke>((_resolve, reject) => {
      fail = reject
    })
    configureHostInvoke(() => slow)
    const stale = loadHostInvoke()

    const fresh = makeLoader('fresh')
    configureHostInvoke(fresh.loader)
    const after = await loadHostInvoke() // 缓存此刻属于 fresh
    fail?.(new Error('stale loader died'))
    await expect(stale).rejects.toThrow('stale loader died')

    await expect(after<string>('ping')).resolves.toBe('fresh:ping')
    expect(await loadHostInvoke()).toBe(after) // 缓存仍在：fresh 没有被重解析
    expect(fresh.state.calls).toBe(1)
  })
})
