// 接入点登记三条命令：登记的那一条 base URL 怎么进配置、怎么读回、以及**手改配置绕不过判据**
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createModelRoutes } from './index'
import { TEST_API_KEY, useModelTestContext } from './modelTestContext.testHarness'
import type { NodeHostCommandHandler } from '../routeTable'

const context = useModelTestContext()

type EndpointCommand = 'model_endpoint_status' | 'model_endpoint_set' | 'model_endpoint_delete'

/** 经 registrar 取 handler：顺带钉住三条命令真的登记进了路由表（只加文件不注册 = 命令不存在）。 */
function handler(name: EndpointCommand): NodeHostCommandHandler {
  const route = createModelRoutes({ homeDir: context.home })[name]
  if (!route) throw new Error(`未注册的命令：${name}`)
  return route
}

function configPath(): string {
  return join(context.home, '.webAgent', 'config.json')
}

async function readConfig(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(configPath(), 'utf8')) as Record<string, any>
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error('预期失败，却成功了')
    },
    (error: unknown) => error,
  )
}

describe('model_endpoint_status', () => {
  it('没登记过就是 configured:false，且不编造 baseUrl', async () => {
    expect(await handler('model_endpoint_status')({})).toEqual({ configured: false })
  })

  it('配置文件里手写的不合规值一律当没登记——config.json 不是可信输入', async () => {
    // 面板那条路会被 set 拒掉；这条测的是绕过面板、直接编辑文件的那条路。
    for (const smuggled of [
      'http://evil.example.com/v1',
      'https://user:pass@api.example.com/v1',
      'https://api.example.com/v1?key=leak',
      'file:///etc/passwd',
      'not a url',
    ]) {
      await context.writeCredentials({ 'openai-compat:default:baseUrl': smuggled })
      expect(await handler('model_endpoint_status')({})).toEqual({ configured: false })
    }
  })
})

describe('model_endpoint_set', () => {
  it('登记成功后回显**归一化后**的地址，配置里存的也是归一化后的值', async () => {
    const status = await handler('model_endpoint_set')({
      input: { baseUrl: '  https://api.example.com/v1/  ' },
    })

    expect(status).toEqual({ configured: true, baseUrl: 'https://api.example.com/v1' })
    expect((await readConfig()).modelCredentials['openai-compat:default:baseUrl'])
      .toBe('https://api.example.com/v1')
    expect(await handler('model_endpoint_status')({})).toEqual({
      configured: true,
      baseUrl: 'https://api.example.com/v1',
    })
  })

  it('回环上的明文 http 放行（自建网关的典型形态）', async () => {
    expect(await handler('model_endpoint_set')({ input: { baseUrl: 'http://127.0.0.1:8080/v1' } }))
      .toEqual({ configured: true, baseUrl: 'http://127.0.0.1:8080/v1' })
  })

  it('不合规的地址整次拒绝，且**一个字节都不落盘**', async () => {
    await handler('model_endpoint_set')({ input: { baseUrl: 'https://good.example.com/v1' } })

    const error = await rejection(
      handler('model_endpoint_set')({ input: { baseUrl: 'http://evil.example.com/v1' } }),
    )

    expect((error as Error).message).toBe('模型接入点地址未获允许')
    expect((error as { reason?: string }).reason).toBe('target-not-allowed')
    // 上一条能用的登记必须还在：填错一个字母不该把跑得通的接入点弄没了。
    expect(await handler('model_endpoint_status')({})).toEqual({
      configured: true,
      baseUrl: 'https://good.example.com/v1',
    })
  })

  it('入参形状不对是「格式无效」，不是「地址未获允许」——两者补救动作不同', async () => {
    for (const args of [
      {},
      { input: {} },
      { input: { baseUrl: 42 } },
      // deny_unknown_fields 的等价物：多一个键就是没按契约发。
      { input: { baseUrl: 'https://api.example.com', origin: 'https://evil.example.com' } },
    ]) {
      const error = await rejection(handler('model_endpoint_set')(args as never))
      expect((error as Error).message).toBe('模型请求格式无效')
    }
  })

  it('登记不碰凭证段里的 Key，也不回显任何 Key', async () => {
    await context.writeCredentials({
      'deepseek:default': TEST_API_KEY,
      'openai-compat:default': TEST_API_KEY,
    })

    const status = await handler('model_endpoint_set')({
      input: { baseUrl: 'https://api.example.com/v1' },
    })

    expect(JSON.stringify(status)).not.toContain(TEST_API_KEY)
    const credentials = (await readConfig()).modelCredentials
    expect(credentials['deepseek:default']).toBe(TEST_API_KEY)
    expect(credentials['openai-compat:default']).toBe(TEST_API_KEY)
  })
})

describe('model_endpoint_delete', () => {
  it('撤销登记之后立刻回到 configured:false', async () => {
    await handler('model_endpoint_set')({ input: { baseUrl: 'https://api.example.com/v1' } })

    expect(await handler('model_endpoint_delete')({})).toEqual({ configured: false })
    expect((await readConfig()).modelCredentials['openai-compat:default:baseUrl']).toBeUndefined()
  })

  it('本来就没登记时也照常回 configured:false，不报错', async () => {
    expect(await handler('model_endpoint_delete')({})).toEqual({ configured: false })
  })

  it('撤销只动自己那一条，凭证与 mcp 段原样保留', async () => {
    await writeFile(
      configPath(),
      JSON.stringify({
        version: 1,
        mcp: { servers: { demo: { command: 'x' } } },
        modelCredentials: {
          'deepseek:default': TEST_API_KEY,
          'openai-compat:default:baseUrl': 'https://api.example.com/v1',
        },
      }),
    )

    await handler('model_endpoint_delete')({})

    const config = await readConfig()
    expect(config.mcp).toEqual({ servers: { demo: { command: 'x' } } })
    expect(config.modelCredentials).toEqual({ 'deepseek:default': TEST_API_KEY })
  })
})
