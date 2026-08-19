import { describe, expect, it, vi } from 'vitest'
import { MODEL_CREDENTIALS, type ModelCredentialHost } from './modelCredentialHost'
import { createServerModelCredentialHost } from './serverModelCredentialHost'

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

describe('createServerModelCredentialHost', () => {
  // 【T1 改了判据】这一条此前是「与桌面版逐字相同」——拿 `createTauriModelCredentialHost()`
  // 发出的调用当参照物。桌面端退出后参照物没了，而契约本身还在：另一端是 host-node 的
  // `model/credentialCommands.ts`，命令名或入参形状差一个字，症状是「存不进去」而两边各自的
  // 测试都还是绿的。所以参照物换成**写死的表**——它现在是这份契约在前端这一侧的唯一权威。
  it('每个凭据目标都发出 status/set/delete 三条命令，命令名与入参形状写死', async () => {
    const calls: Call[] = []
    await exercise(createServerModelCredentialHost(recordingInvoke(calls)))

    expect(calls).toEqual(MODEL_CREDENTIALS.flatMap(({ target: { provider, scope } }) => [
      { cmd: 'model_credential_status', args: { provider, scope } },
      { cmd: 'model_credential_set', args: { input: { provider, scope, apiKey: API_KEY } } },
      { cmd: 'model_credential_delete', args: { provider, scope } },
    ]))
    expect(calls).toHaveLength(MODEL_CREDENTIALS.length * 3)
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
    // B2 的 reject 是**裸字符串**，不是 Error。
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
