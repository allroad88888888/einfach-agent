import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfigPaths } from './configPaths'
import { mergeMcpSection, readMcpSection } from './mcpConfigSection'
import { createWebAgentConfigStore } from './webAgentConfigStore'

let home: string

const configPath = () => join(home, '.webAgent', 'config.json')

async function store() {
  return createWebAgentConfigStore(await resolveConfigPaths(home, undefined))
}

async function writeConfig(contents: string): Promise<void> {
  await mkdir(dirname(configPath()), { recursive: true })
  await writeFile(configPath(), contents)
}

async function storedConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath(), 'utf8'))
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'web-agent-mcp-section-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('读取 mcp 段', () => {
  it('配置文件或该段不存在时给空对象', async () => {
    await expect(readMcpSection(await store())).resolves.toEqual({})

    await writeConfig('{"version":1,"otherSetting":{"enabled":true}}')
    await expect(readMcpSection(await store())).resolves.toEqual({})
  })

  it('只返回 mcp 段，同一份文件里的模型凭证不出现在返回值里', async () => {
    // 这条是本卡的凭证边界：前端经 mcp_config_read 拿到的东西里**没有** Key，不是因为某处
    // 过滤掉了它，而是因为请求的段名是 mcp——别的段压根不在返回路径上。
    await writeConfig(
      '{"version":1,"mcp":{"servers":["local"]},"modelCredentials":{"deepseek:default":"secret"}}',
    )

    const section = await readMcpSection(await store())

    expect(section).toEqual({ servers: ['local'] })
    expect(JSON.stringify(section)).not.toContain('secret')
    expect(JSON.stringify(section)).not.toContain('modelCredentials')
  })
})

describe('合并 mcp 段', () => {
  it('按顶层键整值替换，同段其余键保留——不是深合并、也不是整段覆盖', async () => {
    await writeConfig(
      '{"version":1,"mcp":{"servers":["local"],"toolNameCache":{"a":1}},"modelCredentials":{"deepseek:default":"secret"}}',
    )

    const merged = await mergeMcpSection(await store(), { servers: ['remote'] })

    expect(merged).toEqual({
      // 深合并会把 ["local"] 与 ["remote"] 揉在一起；整段覆盖会让 toolNameCache 消失。
      servers: ['remote'],
      toolNameCache: { a: 1 },
    })
    const config = await storedConfig()
    expect(config.mcp).toEqual(merged)
    expect(config.version).toBe(1)
    // 合并一个段不碰别的段：凭证还在原处。
    expect(config.modelCredentials).toEqual({ 'deepseek:default': 'secret' })
  })

  it('嵌套对象也是整值替换，不逐层合并', async () => {
    await writeConfig('{"version":1,"mcp":{"toolNameCache":{"keep":1,"drop":2}}}')

    const merged = await mergeMcpSection(await store(), { toolNameCache: { keep: 9 } })

    // 深合并会留下 drop:2。区分「深合并」与「顶层浅合并」的就是这一条。
    expect(merged).toEqual({ toolNameCache: { keep: 9 } })
  })

  it('值为 null 表示删键，不是写入 null', async () => {
    await writeConfig('{"version":1,"mcp":{"local":{"status":"connected"},"remote":{}}}')

    const merged = await mergeMcpSection(await store(), { remote: null })

    expect(merged).toEqual({ local: { status: 'connected' } })
    expect((await storedConfig()).mcp).toEqual({ local: { status: 'connected' } })
  })

  it('值为 undefined 的键当作没写——两种传输下行为一致', async () => {
    await writeConfig('{"version":1,"mcp":{"servers":["local"]}}')

    // 走 HTTP 时 JSON.stringify 会把这个键整个丢掉，进程内注入却到得了 handler。
    // 不跳过就成了「本地能删、上 server 删不掉」。要删键请传 null。
    const merged = await mergeMcpSection(await store(), { servers: undefined })

    expect(merged).toEqual({ servers: ['local'] })
  })

  it('配置文件不存在时从零建出 mcp 段', async () => {
    const merged = await mergeMcpSection(await store(), { local: { status: 'connected' } })

    expect(merged).toEqual({ local: { status: 'connected' } })
    expect((await storedConfig()).mcp).toEqual(merged)
  })

  it('补丁不是 JSON 对象时受控失败，不当成空补丁', async () => {
    await expect(mergeMcpSection(await store(), ['not', 'an', 'object'])).rejects.toThrow(
      'mcp 配置段补丁必须是 JSON 对象',
    )
    await expect(mergeMcpSection(await store(), null)).rejects.toThrow(
      'mcp 配置段补丁必须是 JSON 对象',
    )
  })

  it('现有 mcp 段不是对象时受控失败，且不覆盖它', async () => {
    await writeConfig('{"version":1,"mcp":"oops"}')

    await expect(mergeMcpSection(await store(), { local: {} })).rejects.toThrow(
      'mcp 配置段格式无效',
    )
    await expect(readFile(configPath(), 'utf8')).resolves.toBe('{"version":1,"mcp":"oops"}')
  })

  it('补丁里叫 modelCredentials 的键只落进 mcp 段内，动不了顶层的凭证段', async () => {
    await writeConfig('{"version":1,"modelCredentials":{"deepseek:default":"secret"}}')

    await mergeMcpSection(await store(), { modelCredentials: { 'deepseek:default': 'stolen' } })

    const config = await storedConfig()
    // 顶层凭证段原封不动；补丁里的同名键住在 mcp 段里，是另一个东西。
    expect(config.modelCredentials).toEqual({ 'deepseek:default': 'secret' })
    expect(config.mcp).toEqual({ modelCredentials: { 'deepseek:default': 'stolen' } })
  })

  it('并发合并不丢键', async () => {
    // 读—改—写中间隔着两次 await：没有串行化的话，后写的那次会把先写的键整个抹掉。
    const writers = Array.from({ length: 8 }, (_, index) =>
      store().then((instance) =>
        mergeMcpSection(instance, { [`server-${index}`]: { status: 'connected' } }),
      ),
    )
    await Promise.all(writers)

    const section = await readMcpSection(await store())
    expect(Object.keys(section as Record<string, unknown>).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `server-${index}`).sort(),
    )
  })
})
