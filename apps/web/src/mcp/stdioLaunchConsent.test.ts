import { describe, expect, it } from 'vitest'
import { sanitizePersistedMcpConfig } from './config'
import {
  grantStdioLaunchConsent,
  mayLaunchMcpServer,
  sanitizeStdioLaunchConsent,
  stdioCommandLine,
  stdioLaunchEnvNames,
  stdioLaunchFingerprint,
} from './stdioLaunchConsent'
import type { PersistedStdioMcpServer } from './types'

const PLAYWRIGHT: PersistedStdioMcpServer = {
  id: 'playwright',
  name: 'Playwright MCP',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@playwright/mcp@latest'],
  autoConnect: false,
}

const CONFIRMED = grantStdioLaunchConsent(PLAYWRIGHT, 1_700_000_000_000)

describe('stdio 起进程确认 · 确认绑在命令行上', () => {
  it('HTTP 不需要确认：它不在本机起进程', () => {
    expect(mayLaunchMcpServer({
      id: 'remote',
      name: '远端',
      transport: 'streamable-http',
      url: 'https://remote.example.com/mcp',
      autoConnect: true,
    })).toBe(true)
  })

  it('没有确认记录的 stdio 一律不允许启动', () => {
    expect(mayLaunchMcpServer(PLAYWRIGHT)).toBe(false)
  })

  it('确认过当前这条命令行才允许启动', () => {
    expect(mayLaunchMcpServer(CONFIRMED)).toBe(true)
  })

  it.each([
    ['命令', { command: 'node' }],
    ['参数', { args: ['-y', '@evil/mcp@latest'] }],
    ['多一个参数', { args: ['-y', '@playwright/mcp@latest', '--allow-all'] }],
    ['工作目录', { cwd: '/somewhere/else' }],
    // env 与前几项同语义：它不改命令行的一个字，却能换掉这条命令实际执行的代码。
    ['环境变量', { env: { LD_PRELOAD: '/tmp/evil.so' } }],
  ])('改了%s之后旧确认作废（这就是不绑在服务 id 上的原因）', (_label, patch) => {
    const edited = { ...CONFIRMED, ...patch } as PersistedStdioMcpServer

    expect(mayLaunchMcpServer(edited)).toBe(false)
    // 改回去还算数：确认没有被清掉，只是暂时对不上。
    expect(mayLaunchMcpServer({
      ...PLAYWRIGHT,
      launchConsent: edited.launchConsent,
    })).toBe(true)
  })

  it('别的服务的确认套不到这条命令上，同一条命令行换个服务 id 仍然算数', () => {
    const otherCommand = grantStdioLaunchConsent(
      { ...PLAYWRIGHT, id: 'other', command: 'node' },
      1,
    )
    expect(mayLaunchMcpServer({
      ...PLAYWRIGHT,
      launchConsent: otherCommand.launchConsent,
    })).toBe(false)
    // 指纹不含 id / name：同一条命令行改个显示名不该重新问一次。
    expect(mayLaunchMcpServer({ ...CONFIRMED, id: 'renamed', name: '改了名字' })).toBe(true)
  })

  it('参数边界无歧义：`cmd "a b"` 与 `cmd a b` 不是同一条命令行', () => {
    const oneArg = stdioLaunchFingerprint({ ...PLAYWRIGHT, args: ['a b'] })
    const twoArgs = stdioLaunchFingerprint({ ...PLAYWRIGHT, args: ['a', 'b'] })

    expect(oneArg).not.toBe(twoArgs)
  })

  it('展示用的命令行就是 command + args', () => {
    expect(stdioCommandLine(PLAYWRIGHT)).toBe('npx -y @playwright/mcp@latest')
  })
})

describe('stdio 起进程确认 · env 也算这条命令行的一部分（C2a）', () => {
  const ENV = { NODE_OPTIONS: '--require /tmp/inject.js' }
  const WITH_ENV: PersistedStdioMcpServer = { ...PLAYWRIGHT, env: ENV }
  const CONFIRMED_WITH_ENV = grantStdioLaunchConsent(WITH_ENV, 1_700_000_000_000)

  // 这两个字面量是 C2a 之前那版实现（[command, args, cwd] 三元组）对同一份配置的产出，
  // 抄在这里当回归基线：它一变，全体没有 env 的存量 stdio 服务就会被要求重新确认一次，
  // 而那些命令行一个字都没改过。
  it('无 env 的存量配置指纹逐字节不变：这次升级不作废任何老确认', () => {
    expect(stdioLaunchFingerprint(PLAYWRIGHT))
      .toBe('["npx",["-y","@playwright/mcp@latest"],null]')
    expect(stdioLaunchFingerprint({ ...PLAYWRIGHT, cwd: '/repo' }))
      .toBe('["npx",["-y","@playwright/mcp@latest"],"/repo"]')
  })

  it('空 env 与没有 env 是同一个指纹：对子进程本来就是同一件事', () => {
    expect(stdioLaunchFingerprint({ ...PLAYWRIGHT, env: {} }))
      .toBe(stdioLaunchFingerprint(PLAYWRIGHT))
  })

  it.each([
    ['加了 env', PLAYWRIGHT, WITH_ENV],
    ['删了 env', WITH_ENV, PLAYWRIGHT],
    ['改了 env 的值', WITH_ENV, { ...PLAYWRIGHT, env: { NODE_OPTIONS: '--require /tmp/other.js' } }],
    ['改了 env 的键', WITH_ENV, { ...PLAYWRIGHT, env: { LD_PRELOAD: '--require /tmp/inject.js' } }],
  ])('%s：指纹就不是同一个了', (_label, before: PersistedStdioMcpServer, after: PersistedStdioMcpServer) => {
    expect(stdioLaunchFingerprint(before)).not.toBe(stdioLaunchFingerprint(after))
  })

  it('改 env 让既有确认作废，改回来自动恢复（与改 command/args/cwd 同语义）', () => {
    expect(mayLaunchMcpServer(CONFIRMED_WITH_ENV)).toBe(true)
    expect(mayLaunchMcpServer({
      ...CONFIRMED_WITH_ENV,
      env: { NODE_OPTIONS: '--require /tmp/evil.js' },
    })).toBe(false)

    // 删掉 env 同样作废：少一个变量照样可能换掉实际跑起来的东西。
    const { env: _env, ...withoutEnv } = CONFIRMED_WITH_ENV
    expect(mayLaunchMcpServer(withoutEnv)).toBe(false)
    // 删了再加回同一份，指纹回到原值——确认没有被清掉，只是暂时对不上。
    expect(mayLaunchMcpServer({ ...withoutEnv, env: { ...ENV } })).toBe(true)
  })

  it('env 的键序不影响指纹：`{A,B}` 与 `{B,A}` 是同一份环境', () => {
    expect(stdioLaunchFingerprint({ ...PLAYWRIGHT, env: { A: '1', B: '2' } }))
      .toBe(stdioLaunchFingerprint({ ...PLAYWRIGHT, env: { B: '2', A: '1' } }))
  })

  it('键与值的边界无歧义：`{A: "B=1"}` 不该撞上 `{"A=B": "1"}`', () => {
    expect(stdioLaunchFingerprint({ ...PLAYWRIGHT, env: { A: 'B=1' } }))
      .not.toBe(stdioLaunchFingerprint({ ...PLAYWRIGHT, env: { 'A=B': '1' } }))
  })

  it('确认卡片只点名 env 的键：卡片会被截屏，值是凭据', () => {
    expect(stdioLaunchEnvNames({
      ...PLAYWRIGHT,
      env: { PATH: '/tmp/bin', LD_PRELOAD: '/tmp/evil.so' },
    })).toEqual(['LD_PRELOAD', 'PATH'])
    expect(stdioLaunchEnvNames(PLAYWRIGHT)).toEqual([])
    expect(stdioLaunchEnvNames({ ...PLAYWRIGHT, env: {} })).toEqual([])
  })

  it('展示用的命令行不含 env：它还兼着与 tools/mcp 探针比对的差事', () => {
    // initialize.ts 的 isMcpLaunchConsented 拿这个字符串去比 connectTargetProbe 独立算出的
    // command + args。塞了 env 就永远比不相等，带 env 的服务每次连接都要重新确认。
    expect(stdioCommandLine(WITH_ENV)).toBe('npx -y @playwright/mcp@latest')
  })
})

describe('stdio 起进程确认 · 读盘', () => {
  it('确认记录能原样读回来', () => {
    const restored = sanitizePersistedMcpConfig(JSON.parse(JSON.stringify(CONFIRMED)))

    expect(restored).toEqual(CONFIRMED)
    expect(mayLaunchMcpServer(restored!)).toBe(true)
  })

  it.each([
    ['缺字段', { fingerprint: 'x' }],
    ['类型不对', { fingerprint: 123, approvedAt: 1 }],
    ['时间不是数字', { fingerprint: 'x', approvedAt: 'yesterday' }],
    ['空指纹', { fingerprint: '', approvedAt: 1 }],
    ['不是对象', 'approved'],
    ['数组', ['approved']],
  ])('形状不对的确认记录（%s）直接丢掉', (_label, value) => {
    expect(sanitizeStdioLaunchConsent(value)).toBeUndefined()
  })

  it('伪造成超长字符串的指纹不落地', () => {
    expect(sanitizeStdioLaunchConsent({
      fingerprint: 'x'.repeat(600_001),
      approvedAt: 1,
    })).toBeUndefined()
  })

  // C2a 把上限从 200 000 抬到 600 000：env 进指纹之后，一份「填满 config.ts / credentialFields.ts
  // 各项上限但完全合法」的配置本来就会算出 20 万字符以上的指纹。上限判死它，用户就会陷入
  // 「确认了，下次冷启动还要再确认」——每次写下的指纹读盘时都被丢掉。
  it('合法配置能撑到的最长指纹仍然落得了地', () => {
    const maxed = stdioLaunchFingerprint({
      ...PLAYWRIGHT,
      command: 'c'.repeat(512),
      args: Array.from({ length: 64 }, () => 'a'.repeat(1_024)),
      cwd: '/'.padEnd(1_024, 'd'),
      env: Object.fromEntries(
        Array.from({ length: 32 }, (_value, index) => [
          `E${String(index).padEnd(127, '_')}`,
          'v'.repeat(4_096),
        ]),
      ),
    })

    expect(maxed.length).toBeGreaterThan(200_000)
    expect(sanitizeStdioLaunchConsent({ fingerprint: maxed, approvedAt: 1 }))
      .toEqual({ fingerprint: maxed, approvedAt: 1 })
  })

  it('被改坏的确认记录不会让整条配置作废，只是这个服务不能启动', () => {
    const restored = sanitizePersistedMcpConfig({
      ...PLAYWRIGHT,
      launchConsent: { fingerprint: 42 },
    })

    expect(restored).toEqual(PLAYWRIGHT)
    expect(mayLaunchMcpServer(restored!)).toBe(false)
  })
})
