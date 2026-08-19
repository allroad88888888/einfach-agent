import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { McpCommandError } from './errors'
import { fakeConnectArgs } from './fakeMcpServer.testHarness'
import { createMcpRoutes } from './index'
import { narrowConnectInput, narrowListToolsInput } from './inputs'
import { normalizeIdentifier, trimUnicodeWhitespace } from './validation'
import type { NodeHostRouteTable } from '../routeTable'

let dispose: (() => Promise<void>) | undefined

function routes(): NodeHostRouteTable {
  let captured: (() => Promise<void>) | undefined
  const table = createMcpRoutes({ registerHostDisposer: (fn) => { captured = fn } })
  dispose = captured
  return table
}

afterEach(async () => {
  await dispose?.()
  dispose = undefined
})

function connectPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input: { serverId: 'a', sessionToken: 'b', command: 'node', ...overrides },
  }
}

function expectInvalid(run: () => unknown): McpCommandError {
  try {
    run()
    return expect.fail('本该被拒的载荷通过了')
  } catch (error) {
    expect(error).toBeInstanceOf(McpCommandError)
    expect((error as McpCommandError).kind).toBe('invalid_input')
    return error as McpCommandError
  }
}

describe('入参收窄（这张表要挂在 HTTP 后面，载荷是外部输入）', () => {
  it('剥掉外层 input，缺席的可选项一律 undefined', () => {
    const input = narrowConnectInput(connectPayload())
    expect(input).toEqual({
      serverId: 'a',
      sessionToken: 'b',
      command: 'node',
      args: [],
      cwd: undefined,
      env: {},
      requestTimeoutMs: undefined,
      protocolVersion: undefined,
      clientInfo: undefined,
    })
  })

  it('显式写成 undefined 的可选项 == 缺席', () => {
    // core 的 toTauriInput 整份对象字面量返回，可选项无值时**键存在且为 undefined**；
    // 走 HTTP 时 JSON.stringify 又会把它丢掉。用 `'key' in args` 判存在，会写出
    // 「CLI 上能跑、上 server 就变」的 bug，而且只在某个可选参数没传时才现形。
    const explicit = narrowListToolsInput({
      input: {
        serverId: 'a',
        sessionToken: 'b',
        cursor: undefined,
        allPages: undefined,
        maxPages: undefined,
        timeoutMs: undefined,
      },
    })
    const absent = narrowListToolsInput({ input: { serverId: 'a', sessionToken: 'b' } })
    expect(explicit).toEqual(absent)
  })

  it('空串 cwd 当没配（照搬 Rust 的 filter(!is_empty)）', () => {
    expect(narrowConnectInput(connectPayload({ cwd: '' })).cwd).toBeUndefined()
    expect(narrowConnectInput(connectPayload({ cwd: '/tmp' })).cwd).toBe('/tmp')
  })

  it('形状不对一律 invalid_input，不是裸 TypeError', () => {
    expectInvalid(() => narrowConnectInput({}))
    expectInvalid(() => narrowConnectInput({ input: [] }))
    expectInvalid(() => narrowConnectInput(connectPayload({ serverId: 7 })))
    expectInvalid(() => narrowConnectInput(connectPayload({ args: 'not-an-array' })))
    expectInvalid(() => narrowConnectInput(connectPayload({ args: ['ok', 7] })))
    expectInvalid(() => narrowConnectInput(connectPayload({ env: { KEY: 7 } })))
    expectInvalid(() => narrowConnectInput(connectPayload({ clientInfo: { name: 'x' } })))
  })

  it('超时必须是非负整数：负数、小数、超安全整数范围全拒', () => {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2, '30000', NaN]) {
      expectInvalid(() => narrowConnectInput(connectPayload({ requestTimeoutMs: value })))
    }
    // 0 在收窄这一层是合法的整数；「超时不能为 0」由 normalizeTimeout 判，两层分工不同。
    expect(narrowConnectInput(connectPayload({ requestTimeoutMs: 0 })).requestTimeoutMs).toBe(0)
  })

  it('env 只收自有键，`__proto__` 不会污染原型', () => {
    const env = narrowConnectInput(
      connectPayload({ env: JSON.parse('{"__proto__":"bad","OK":"1"}') as unknown }),
    ).env
    expect(env.OK).toBe('1')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('标识符归一化', () => {
  it('长度按字节量而不是 UTF-16 码元', () => {
    // 100 个汉字 = 300 字节，`.length` 只有 100。按码元判会放进一个 Rust 侧会拒的 ID。
    const chinese = '汉'.repeat(100)
    expect(chinese.length).toBe(100)
    const error = expectInvalid(() => normalizeIdentifier(chinese, 'serverId'))
    expect(error.message).toBe('serverId must not exceed 256 bytes')
    expect(normalizeIdentifier('汉'.repeat(85), 'serverId')).toHaveLength(85)
  })

  it('拒空、拒 NUL', () => {
    expectInvalid(() => normalizeIdentifier('   ', 'serverId'))
    expectInvalid(() => normalizeIdentifier('a\0b', 'serverId'))
  })

  it('trim 按 Unicode White_Space，而不是 JS 的 trim', () => {
    // 两处不相等：JS 多剪 U+FEFF（Unicode 里它不是 White_Space），少剪 U+0085（NEL）。
    // 两个宿主对同一个 serverId 必须归一化成同一个字符串，否则登记表会对不上而无人报错。
    expect(trimUnicodeWhitespace(' a ')).toBe('a')
    expect(trimUnicodeWhitespace('\uFEFFa')).toBe('\uFEFFa')
    expect('\uFEFFa'.trim()).toBe('a')
    expect(trimUnicodeWhitespace('\u0085a')).toBe('a')
    expect('\u0085a'.trim()).toBe('\u0085a')
  })
})

describe('命令注入', () => {
  it('args 里的 shell 元字符原样到达子进程，不被解释也不被拆词', async () => {
    // 这是本域唯一的高危动作。配置来自 `~/.webAgent/config.json`，而那份文件的内容可能是
    // 「从聊天里粘一段 mcpServers JSON 导进来」的。拼命令行字符串交给 shell 的写法，
    // 在这里就是一次命令注入。
    const marker = join(tmpdir(), `web-agent-mcp-injection-${process.pid}-${Date.now()}`)
    const hostile = [
      `; touch ${marker}`,
      `&& touch ${marker}`,
      `$(touch ${marker})`,
      '`id`',
      'two words',
      '*',
    ]
    const table = routes()
    await table.mcp_connect?.(
      fakeConnectArgs({ serverId: 'inj', mode: 'argv', extraArgs: hostile }),
    )
    const called = await table.mcp_call_tool?.({
      input: { serverId: 'inj', sessionToken: 'inj-session', name: 'echo-argv' },
    }) as { content: { text: string }[] }

    // 逐个 argv 条目、逐字相同：既没有 shell 解释，也没有按空白拆成两个参数，也没有 glob 展开。
    expect(JSON.parse(called.content[0]?.text ?? '[]')).toEqual(hostile)
    expect(existsSync(marker), '任何一个注入片段都不该真的执行').toBe(false)

    await table.mcp_disconnect?.({ input: { serverId: 'inj', sessionToken: 'inj-session' } })
  })
})
