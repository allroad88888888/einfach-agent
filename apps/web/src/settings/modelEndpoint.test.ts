// 接入点登记这条链：命令形状、界面状态、以及**登记必须同时喂给受限传输**
import { uiStore } from '../uiStore'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openAiCompatOrigin, applyOpenAiCompatEndpoint } from '../modelTransport/openAiCompatEndpoint'
import {
  configureModelEndpointHost,
  deleteModelEndpoint,
  hydrateModelEndpoint,
  saveModelEndpoint,
  updateModelEndpointDraft,
} from './commands'
import {
  createUnavailableModelEndpointHost,
  type ModelEndpointHost,
  type ModelEndpointStatus,
} from './modelEndpointHost'
import { createServerModelEndpointHost } from './serverModelEndpointHost'
import { modelEndpointEntryAtom, resetModelEndpointState } from './modelEndpointState'

const GATEWAY = 'https://gateway.example.com/v1'

interface Call {
  readonly cmd: string
  readonly args: Record<string, unknown> | undefined
}

function recordingInvoke(calls: Call[], result: unknown) {
  return async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args })
    return result as T
  }
}

/** 一个会记账的假后端：只接受 https，模拟后端那条判据的「不合规就拒绝」这一面。 */
function fakeHost(): { host: ModelEndpointHost; registered: () => string | undefined } {
  let registered: string | undefined
  const status = (): ModelEndpointStatus => (
    registered === undefined ? { configured: false } : { configured: true, baseUrl: registered }
  )
  return {
    host: {
      available: true,
      status: async () => status(),
      save: async (baseUrl) => {
        if (!baseUrl.startsWith('https://')) throw new Error('模型接入点地址未获允许')
        // 后端回的是**归一化后**的值，前端拿到什么就用什么。
        registered = baseUrl.replace(/\/+$/, '')
        return status()
      },
      delete: async () => {
        registered = undefined
        return status()
      },
    },
    registered: () => registered,
  }
}

function entry() {
  return uiStore.getter(modelEndpointEntryAtom)
}

beforeEach(() => {
  resetModelEndpointState(uiStore)
  applyOpenAiCompatEndpoint(undefined)
})

afterEach(() => {
  configureModelEndpointHost(createUnavailableModelEndpointHost())
  applyOpenAiCompatEndpoint(undefined)
})

describe('createServerModelEndpointHost', () => {
  it('三条命令的名字与入参形状写死——差一个字的症状是「存不进去」而两边测试都绿', async () => {
    const calls: Call[] = []
    const host = createServerModelEndpointHost(recordingInvoke(calls, { configured: false }))

    await host.status()
    await host.save(GATEWAY)
    await host.delete()

    expect(calls).toEqual([
      { cmd: 'model_endpoint_status', args: undefined },
      { cmd: 'model_endpoint_set', args: { input: { baseUrl: GATEWAY } } },
      { cmd: 'model_endpoint_delete', args: undefined },
    ])
    expect(host.available).toBe(true)
  })

  it('返回体原样透传，失败原样抛出（不折成「没登记」）', async () => {
    const passthrough = createServerModelEndpointHost(async () => (
      { configured: true, baseUrl: GATEWAY } as never
    ))
    await expect(passthrough.status()).resolves.toEqual({ configured: true, baseUrl: GATEWAY })

    // httpInvoke reject 的是**裸字符串**，与 Tauri invoke 逐字一致。
    const failing = createServerModelEndpointHost(async () => {
      throw '本地服务返回了非预期的错误响应（HTTP 401）。'
    })
    await expect(failing.status()).rejects.toBe('本地服务返回了非预期的错误响应（HTTP 401）。')
  })
})

describe('没有本机后端时', () => {
  it('如实说存不进去，而不是给一个存不进去的框', async () => {
    const host = createUnavailableModelEndpointHost()
    expect(host.available).toBe(false)
    await expect(host.status()).resolves.toEqual({ configured: false })
    await expect(host.save(GATEWAY)).rejects.toThrow('当前页面没有连上本机后端')
  })
})

describe('hydrate', () => {
  it('把后端的登记同时喂给界面和受限传输', async () => {
    const { host } = fakeHost()
    await host.save(GATEWAY)
    configureModelEndpointHost(host)

    await hydrateModelEndpoint()

    expect(entry().state).toEqual({ status: 'ready', configured: true, baseUrl: GATEWAY })
    expect(openAiCompatOrigin()).toBe(GATEWAY)
  })

  it('读不到状态时界面说实话，传输留在「没登记」这一侧', async () => {
    configureModelEndpointHost({
      available: true,
      status: async () => { throw new Error('炸了') },
      save: async () => { throw new Error('炸了') },
      delete: async () => { throw new Error('炸了') },
    })

    await hydrateModelEndpoint()

    expect(entry().state.status).toBe('error')
    expect(entry().state.configured).toBe(false)
    // 读不到 ≠ 没登记，但传输必须停在发不出去的那一侧。
    expect(openAiCompatOrigin()).toBeUndefined()
  })
})

describe('保存', () => {
  it('登记成功后清空草稿，并让传输立刻认得出这个接入点', async () => {
    const { host, registered } = fakeHost()
    configureModelEndpointHost(host)

    updateModelEndpointDraft(`${GATEWAY}/`)
    expect(await saveModelEndpoint()).toBe(true)

    expect(registered()).toBe(GATEWAY)
    expect(entry().draft).toBe('')
    expect(entry().state).toEqual({ status: 'saved', configured: true, baseUrl: GATEWAY })
    expect(openAiCompatOrigin()).toBe(GATEWAY)
  })

  it('后端拒绝时：显示后端那句话、**草稿留着**、原来的登记不动', async () => {
    const { host } = fakeHost()
    configureModelEndpointHost(host)
    updateModelEndpointDraft(GATEWAY)
    await saveModelEndpoint()

    updateModelEndpointDraft('http://evil.example.com/v1')
    expect(await saveModelEndpoint()).toBe(false)

    // 前端不另编一句解释：它没有判据，编出来的可能与真正的拒绝理由不符。
    expect(entry().state).toEqual({
      status: 'error',
      error: '模型接入点地址未获允许',
      configured: true,
      baseUrl: GATEWAY,
    })
    // 填错一个字母不该把跑得通的接入点弄没了，也不该逼用户重打一遍。
    expect(entry().draft).toBe('http://evil.example.com/v1')
    expect(openAiCompatOrigin()).toBe(GATEWAY)
  })

  it('草稿是空的就不发请求', async () => {
    const { host } = fakeHost()
    configureModelEndpointHost(host)

    updateModelEndpointDraft('   ')
    expect(await saveModelEndpoint()).toBe(false)
    expect(entry().state.status).toBe('error')
    expect(openAiCompatOrigin()).toBeUndefined()
  })
})

describe('删除', () => {
  it('撤销登记之后传输也立刻回到发不出去的那一侧', async () => {
    const { host, registered } = fakeHost()
    configureModelEndpointHost(host)
    updateModelEndpointDraft(GATEWAY)
    await saveModelEndpoint()

    expect(await deleteModelEndpoint()).toBe(true)

    expect(registered()).toBeUndefined()
    expect(entry().state).toEqual({ status: 'saved', configured: false })
    expect(openAiCompatOrigin()).toBeUndefined()
  })
})
