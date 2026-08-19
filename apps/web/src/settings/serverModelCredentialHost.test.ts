import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTauriModelCredentialHost,
  MODEL_CREDENTIALS,
  type ModelCredentialHost,
} from './modelCredentialHost'
import { createServerModelCredentialHost } from './serverModelCredentialHost'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const invokeMock = vi.mocked(invoke)

/** 一把已知 Key，「不外泄」的断言全拿它当探针。 */
const API_KEY = 'sk-secret-server-credential-probe-0123456789'

const STATUS = { configured: true, source: 'config' } as const

interface Call {
  readonly cmd: string
  readonly args: Record<string, unknown> | undefined
}

/** 记录每次调用并回一个固定状态。签名与 core 的 `HostInvoke` 一致。 */
function recordingInvoke(calls: Call[], result: unknown = STATUS) {
  return async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args })
    return result as T
  }
}

/** 让两个工厂跑同一串操作，返回它们各自发出去的调用。 */
async function exercise(host: ModelCredentialHost): Promise<void> {
  for (const { target } of MODEL_CREDENTIALS) {
    await host.status(target)
    await host.save(target, API_KEY)
    await host.delete(target)
  }
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(STATUS)
})

describe('createServerModelCredentialHost', () => {
  it('发出的命令名与入参与桌面版逐字相同', async () => {
    const serverCalls: Call[] = []
    await exercise(createServerModelCredentialHost(recordingInvoke(serverCalls)))
    await exercise(createTauriModelCredentialHost())

    const tauriCalls: Call[] = invokeMock.mock.calls.map(([cmd, args]) => ({
      cmd,
      args: args as Record<string, unknown> | undefined,
    }))
    // 同接口不只是「方法名一样」：同一个设置面板会轮流打到两种宿主上，命令名或入参形状差一个
    // 字，症状是「桌面版能存、浏览器里存不进去」，而两边各自的测试都还是绿的。
    expect(serverCalls).toEqual(tauriCalls)
    expect(serverCalls).toHaveLength(MODEL_CREDENTIALS.length * 3)
  })

  it('三条命令的形状：status/delete 传 provider+scope，set 包一层 input', async () => {
    const calls: Call[] = []
    const host = createServerModelCredentialHost(recordingInvoke(calls))

    await host.status({ provider: 'kimi', scope: 'cn' })
    await host.save({ provider: 'deepseek', scope: 'default' }, API_KEY)
    await host.delete({ provider: 'glm', scope: 'default' })

    expect(calls).toEqual([
      { cmd: 'model_credential_status', args: { provider: 'kimi', scope: 'cn' } },
      {
        cmd: 'model_credential_set',
        args: { input: { provider: 'deepseek', scope: 'default', apiKey: API_KEY } },
      },
      { cmd: 'model_credential_delete', args: { provider: 'glm', scope: 'default' } },
    ])
    expect(host.available).toBe(true)
  })

  it('返回体原样透传，不做任何加工', async () => {
    const host = createServerModelCredentialHost(async () => (
      { configured: false, source: 'missing' } as never
    ))

    await expect(host.status({ provider: 'glm', scope: 'default' }))
      .resolves.toEqual({ configured: false, source: 'missing' })
  })

  it('失败原样抛出，不折成「未配置」', async () => {
    // B2 的 reject 是**裸字符串**（与 Tauri invoke 逐字一致），不是 Error。
    const host = createServerModelCredentialHost(async () => {
      throw '本地服务返回了非预期的错误响应（HTTP 401）。'
    })

    // 吞掉失败并回一个 `{ configured: false }` 会让面板对着一把存好的 Key 说没配置。
    await expect(host.status({ provider: 'glm', scope: 'default' }))
      .rejects.toBe('本地服务返回了非预期的错误响应（HTTP 401）。')
  })

  it('Key 只出现在 set 的请求里，不出现在任何返回体或失败里', async () => {
    const calls: Call[] = []
    const host = createServerModelCredentialHost(recordingInvoke(calls))

    // ① 正面钉住 Key 真的发出去了——否则下面的断言可以靠「压根没发」蒙混过关。
    const saved = await host.save({ provider: 'deepseek', scope: 'default' }, API_KEY)
    expect(JSON.stringify(calls[0]?.args)).toContain(API_KEY)

    // ② 返回体是宿主给的状态，前端这一层没有任何把入参拼回去的机会。
    expect(saved).toEqual(STATUS)
    expect(JSON.stringify(saved)).not.toContain(API_KEY)
    expect(JSON.stringify(await host.status({ provider: 'deepseek', scope: 'default' })))
      .not.toContain(API_KEY)
    expect(JSON.stringify(await host.delete({ provider: 'deepseek', scope: 'default' })))
      .not.toContain(API_KEY)

    // ③ 失败路径同样不许把刚收下的 Key 拼进消息里。
    const failing = createServerModelCredentialHost(async () => {
      throw new Error('模型 API Key 格式无效')
    })
    const error = await failing.save({ provider: 'deepseek', scope: 'default' }, API_KEY)
      .then(() => undefined, (reason: unknown) => reason)
    expect(String(error)).not.toContain(API_KEY)
    expect((error as Error).stack ?? '').not.toContain(API_KEY)
  })
})
