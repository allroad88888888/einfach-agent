import { describe, expect, it } from 'vitest'
import { sanitizePersistedMcpConfig } from './config'
import {
  grantStdioLaunchConsent,
  mayLaunchMcpServer,
  sanitizeStdioLaunchConsent,
  stdioCommandLine,
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
      fingerprint: 'x'.repeat(200_001),
      approvedAt: 1,
    })).toBeUndefined()
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
