import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createModelRoutes } from './index'
import { TEST_API_KEY as API_KEY, useModelTestContext } from './modelTestContext.testHarness'
import type { NodeHostCommandHandler } from '../routeTable'

const context = useModelTestContext()

type CredentialCommand =
  | 'model_credential_status'
  | 'model_credential_set'
  | 'model_credential_delete'

/** 经 registrar 取 handler：顺带钉住三条命令真的登记进了路由表（只加文件不注册 = 命令不存在）。 */
function handler(name: CredentialCommand): NodeHostCommandHandler {
  const route = createModelRoutes({ homeDir: context.home })[name]
  if (!route) throw new Error(`未注册的命令：${name}`)
  return route
}

function configPath(): string {
  return join(context.home, '.webAgent', 'config.json')
}

async function readRawConfig(): Promise<string> {
  return readFile(configPath(), 'utf8')
}

async function readConfig(): Promise<Record<string, any>> {
  return JSON.parse(await readRawConfig()) as Record<string, any>
}

async function writeRawConfig(config: unknown): Promise<void> {
  await writeFile(configPath(), JSON.stringify(config))
}

/** Key 探针要扫的全部表面：一条错误能藏字符串的地方不止 `message`。 */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error ?? null)
  return [String(error), error.message, error.stack ?? '', JSON.stringify(error.cause ?? null)]
    .join('\n')
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error('预期失败，却成功了')
    },
    (error: unknown) => error,
  )
}

describe('model_credential_status', () => {
  it('只回 configured 与 source，未配置时是 missing', async () => {
    await context.writeCredentials({})

    const status = await handler('model_credential_status')({ provider: 'deepseek' })

    expect(status).toEqual({ configured: false, source: 'missing' })
    // 键集合是判据本身：多回一个字段就是多一样经 HTTP 暴露出去的东西。
    expect(Object.keys(status as object)).toEqual(['configured', 'source'])
  })

  it('配置里有归一化之后还在的值才算 configured', async () => {
    await context.writeCredentials({ 'deepseek:default': '  ', 'kimi:cn': API_KEY })

    // 空白后为空 = 没配置（credentials.ts 的 normalizeApiKey，与 Rust 的 normalized_key 同）。
    expect(await handler('model_credential_status')({ provider: 'deepseek' }))
      .toEqual({ configured: false, source: 'missing' })
    expect(await handler('model_credential_status')({ provider: 'kimi', scope: 'cn' }))
      .toEqual({ configured: true, source: 'config' })
  })

  it('scope 缺席按 default 处理，作用域不成立时是受控失败', async () => {
    await context.writeCredentials({ 'deepseek:default': API_KEY })

    expect(await handler('model_credential_status')({ provider: 'deepseek' }))
      .toEqual({ configured: true, source: 'config' })
    // kimi 只有 cn：说「没配置」会让用户去存一把根本存不进去的 Key。
    await expect(handler('model_credential_status')({ provider: 'kimi' }))
      .rejects.toThrow('模型凭证作用域未获允许')
  })
})

describe('model_credential_set 的落盘', () => {
  it('是段更新：mcp 段与未识别的顶层键原样保留', async () => {
    await writeRawConfig({
      version: 1,
      mcp: { servers: [{ id: 'local' }], toolNameCache: { a: 'b' } },
      otherSetting: { enabled: true },
    })

    await handler('model_credential_set')({
      input: { provider: 'deepseek', scope: 'default', apiKey: API_KEY },
    })

    const config = await readConfig()
    // 天真实现（读出 modelCredentials、写回整份文件）在这里会把用户的 MCP 配置抹掉，
    // 而那种损坏在写入的当下毫无症状。
    expect(config.mcp).toEqual({ servers: [{ id: 'local' }], toolNameCache: { a: 'b' } })
    expect(config.otherSetting).toEqual({ enabled: true })
    expect(config.modelCredentials).toEqual({ 'deepseek:default': API_KEY })
  })

  it('trim 之后落盘，键名由绑定表决定', async () => {
    await context.writeCredentials({})

    await handler('model_credential_set')({
      input: { provider: 'kimi', scope: 'cn', apiKey: `  ${API_KEY}  ` },
    })
    await handler('model_credential_set')({
      input: { provider: 'glm', apiKey: 'glm-key' },
    })

    const config = await readConfig()
    expect(config.modelCredentials['kimi:cn']).toBe(API_KEY)
    // scope 缺席 = default（Rust 的 #[serde(default)]）。
    expect(config.modelCredentials['glm:default']).toBe('glm-key')
    // 段内按键排序，对齐 Rust 的 BTreeMap——两个宿主轮流写同一份文件时不会互相重排。
    expect(Object.keys(config.modelCredentials)).toEqual(['glm:default', 'kimi:cn'])
  })

  it('作用域不成立与 Key 格式无效时一个字节都不写', async () => {
    await context.writeCredentials({ 'deepseek:default': API_KEY })
    const before = await readRawConfig()

    // 先查绑定表再归一化（与 Rust 同序）：这个组合的错该指向组合，不该指向用户刚敲的那串字符。
    await expect(handler('model_credential_set')({
      input: { provider: 'kimi', scope: 'default', apiKey: 'k' },
    })).rejects.toThrow('模型凭证作用域未获允许')
    await expect(handler('model_credential_set')({
      input: { provider: 'deepseek', apiKey: '   ' },
    })).rejects.toThrow('模型 API Key 格式无效')
    await expect(handler('model_credential_set')({
      input: { provider: 'deepseek', apiKey: 'k'.repeat(1_025) },
    })).rejects.toThrow('模型 API Key 格式无效')

    expect(await readRawConfig()).toBe(before)
  })
})

describe('model_credential_delete', () => {
  it('只删这一条，其余凭证与其余配置段都还在', async () => {
    await writeRawConfig({
      version: 1,
      mcp: { servers: [] },
      modelCredentials: { 'deepseek:default': 'one', 'kimi:cn': 'two' },
    })

    const status = await handler('model_credential_delete')({ provider: 'deepseek' })

    expect(status).toEqual({ configured: false, source: 'missing' })
    const config = await readConfig()
    expect(config.modelCredentials).toEqual({ 'kimi:cn': 'two' })
    expect(config.mcp).toEqual({ servers: [] })
  })

  it('删一条本来就没有的凭证也成功（与 Rust 同：照常写一次）', async () => {
    await context.writeCredentials({})

    expect(await handler('model_credential_delete')({ provider: 'glm' }))
      .toEqual({ configured: false, source: 'missing' })
    expect((await readConfig()).modelCredentials).toEqual({})
  })
})

describe('坏掉的 modelCredentials 段', () => {
  it('读与写都受控失败，写不会把坏段静默重写成好段', async () => {
    await writeRawConfig({ version: 1, modelCredentials: { 'deepseek:default': 7 } })
    const before = await readRawConfig()

    for (const work of [
      handler('model_credential_status')({ provider: 'deepseek' }),
      handler('model_credential_delete')({ provider: 'deepseek' }),
      handler('model_credential_set')({ input: { provider: 'deepseek', apiKey: 'k' } }),
    ]) {
      await expect(work).rejects.toThrow('模型配置文件格式无效')
    }
    // 只在读那头判的话，一次保存会把坏段重写成好段，用户丢的是自己那几把 Key。
    expect(await readRawConfig()).toBe(before)
  })
})

describe('入参收窄（Rust 侧由 Tauri 的命令参数反序列化承担）', () => {
  it('provider 必须是三家之一，scope 必须是闭合枚举', async () => {
    for (const args of [{}, { provider: 'openai' }, { provider: 'deepseek', scope: 'us' }]) {
      await expect(handler('model_credential_status')(args)).rejects.toThrow('模型请求格式无效')
      await expect(handler('model_credential_delete')(args)).rejects.toThrow('模型请求格式无效')
    }
  })

  it('set 的 input 是 deny_unknown_fields，且 apiKey 必须是字符串', async () => {
    const set = handler('model_credential_set')
    await expect(set({})).rejects.toThrow('模型请求格式无效')
    await expect(set({ input: 'sk-x' })).rejects.toThrow('模型请求格式无效')
    await expect(set({ input: { provider: 'deepseek' } })).rejects.toThrow('模型请求格式无效')
    await expect(set({ input: { provider: 'deepseek', apiKey: 1 } }))
      .rejects.toThrow('模型请求格式无效')
    // 多出来的字段必须被拦：逐键读取天生忽略它们，那正是要拦的东西。
    await expect(set({ input: { provider: 'deepseek', apiKey: 'k', configKey: 'x' } }))
      .rejects.toThrow('模型请求格式无效')
    // 值为 undefined 的可选键当作没写（wireShape.ts：两条传输路径答案必须一致）。
    await expect(set({ input: { provider: 'deepseek', scope: undefined, apiKey: 'k' } }))
      .resolves.toEqual({ configured: true, source: 'config' })
  })
})

describe('Key 不外泄', () => {
  it('已知 Key 走完 set → status → delete，不出现在任何返回体与任何错误消息里', async () => {
    await context.writeCredentials({})
    const leaks = (value: unknown): boolean => JSON.stringify(value ?? null).includes(API_KEY)

    // ① 正面钉住 Key 真的被存进去了——否则下面每一条断言都可以靠「压根没存」蒙混过关。
    const saved = await handler('model_credential_set')({
      input: { provider: 'deepseek', scope: 'default', apiKey: API_KEY },
    })
    expect((await readConfig()).modelCredentials['deepseek:default']).toBe(API_KEY)

    // ② 三次成功返回体。set 尤其：它刚收下这把 Key，回显是最顺手的一步。
    expect(saved).toEqual({ configured: true, source: 'config' })
    expect(leaks(saved)).toBe(false)
    const status = await handler('model_credential_status')({ provider: 'deepseek' })
    expect(status).toEqual({ configured: true, source: 'config' })
    expect(leaks(status)).toBe(false)
    const deleted = await handler('model_credential_delete')({ provider: 'deepseek' })
    expect(leaks(deleted)).toBe(false)

    // ③ Key 在**入参**里而请求被拒：错误消息不许把它带出来。
    const refused = await rejection(handler('model_credential_set')({
      input: { provider: 'kimi', scope: 'default', apiKey: API_KEY },
    }))
    expect((refused as Error).message).toBe('模型凭证作用域未获允许')
    expect(errorText(refused)).not.toContain(API_KEY)

    // ④ Key 在**配置文件**里而这次读取失败：错误也不许把文件内容带出来。
    await writeRawConfig({ version: 1, modelCredentials: { 'deepseek:default': API_KEY, x: 7 } })
    const broken = await rejection(handler('model_credential_status')({ provider: 'deepseek' }))
    expect((broken as Error).message).toBe('模型配置文件格式无效')
    expect(errorText(broken)).not.toContain(API_KEY)

    await writeRawConfig({ version: 2, modelCredentials: { 'deepseek:default': API_KEY } })
    const version = await rejection(handler('model_credential_set')({
      input: { provider: 'deepseek', apiKey: API_KEY },
    }))
    expect((version as Error).message).toBe('模型配置文件版本不受支持')
    expect(errorText(version)).not.toContain(API_KEY)
  })
})
