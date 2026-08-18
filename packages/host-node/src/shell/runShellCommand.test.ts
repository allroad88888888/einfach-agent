import { describe, expect, it } from 'vitest'
import { currentPlatform } from './platform'
import { narrowShellCommandArgs } from './runShellCommand'
import { createShellRoutes } from './index'

const host = currentPlatform()

/** 直接取 registrar 交出来的 handler——本卡不碰 createNodeHostInvoke.ts，也就不经总表。 */
function shellHandler() {
  const handler = createShellRoutes({}).run_shell_command
  if (!handler) throw new Error('registrar 没有交出 run_shell_command')
  return handler
}

describe('createShellRoutes', () => {
  it('只登记 run_shell_command 一条', () => {
    expect(Object.keys(createShellRoutes({}))).toEqual(['run_shell_command'])
  })

  it('handler 收 snake_case 入参并真的跑一条命令', async () => {
    const result = await shellHandler()({
      platform: host,
      command: 'echo wired',
      timeout_ms: 10_000,
      max_output_chars: 1_000,
    })

    expect(result).toMatchObject({ exit_code: 0, timed_out: false })
    expect((result as { stdout: string }).stdout).toContain('wired')
  }, 20_000)
})

describe('narrowShellCommandArgs', () => {
  it('认 snake_case 顶层键（core 的 toTauriInput 已经转好，这层不再转一次）', () => {
    expect(
      narrowShellCommandArgs({
        platform: 'linux',
        command: 'ls',
        cwd: '/tmp',
        timeout_ms: 1_000,
        max_output_chars: 42,
        env: { A: '1' },
      }),
    ).toEqual({
      platform: 'linux',
      command: 'ls',
      cwd: '/tmp',
      timeoutMs: 1_000,
      maxOutputChars: 42,
      env: { A: '1' },
    })
  })

  it('不认驼峰：多认一种写法等于多一条没人测的路径', () => {
    const narrowed = narrowShellCommandArgs({
      platform: 'linux',
      command: 'ls',
      timeoutMs: 1_000,
      maxOutputChars: 42,
    })

    expect(narrowed.timeoutMs).toBeUndefined()
    expect(narrowed.maxOutputChars).toBeUndefined()
  })

  it('「键在但值是 undefined」与「键不存在」等价', () => {
    // core 的 toTauriInput 整份对象字面量返回，可选项无值时键存在且为 undefined；进程内注入
    // 时它原样到达，走 HTTP 时 JSON.stringify 会把它丢掉。两种传输的键集合不同，收窄必须
    // 看值不看键——用 `'key' in args` 会写出「本地能跑、上 server 就变」的 bug。
    const injected = {
      platform: 'linux',
      command: 'ls',
      cwd: undefined,
      timeout_ms: undefined,
      max_output_chars: undefined,
      env: undefined,
    }
    const overHttp = JSON.parse(JSON.stringify(injected)) as Record<string, unknown>

    expect(Object.keys(overHttp)).toEqual(['platform', 'command'])
    expect(narrowShellCommandArgs(injected)).toEqual(narrowShellCommandArgs(overHttp))
  })

  it('必填项缺席与类型不对分开报', () => {
    expect(() => narrowShellCommandArgs({ command: 'ls' })).toThrow(
      'run_shell_command 缺少 platform 参数',
    )
    expect(() => narrowShellCommandArgs({ platform: 'linux' })).toThrow(
      'run_shell_command 缺少 command 参数',
    )
    expect(() => narrowShellCommandArgs({ platform: 1, command: 'ls' })).toThrow(
      'run_shell_command 的 platform 参数必须是字符串，实际收到 number',
    )
  })

  it('可选项类型不对当场失败，不静默丢掉', () => {
    const base = { platform: 'linux', command: 'ls' }

    expect(() => narrowShellCommandArgs({ ...base, cwd: 3 })).toThrow(
      'run_shell_command 的 cwd 参数必须是字符串，实际收到 number',
    )
    expect(() => narrowShellCommandArgs({ ...base, timeout_ms: '500' })).toThrow(
      'run_shell_command 的 timeout_ms 参数必须是有限数字，实际收到 string',
    )
    // NaN 放行的话 setTimeout(NaN) 会当成 0 立刻超时——「参数写错」变成「命令莫名被杀」。
    expect(() => narrowShellCommandArgs({ ...base, max_output_chars: Number.NaN })).toThrow(
      'run_shell_command 的 max_output_chars 参数必须是有限数字，实际收到 number',
    )
  })

  it('env 必须是字符串字典', () => {
    const base = { platform: 'linux', command: 'ls' }

    expect(() => narrowShellCommandArgs({ ...base, env: ['A=1'] })).toThrow(
      'run_shell_command 的 env 参数必须是字符串字典，实际收到 array',
    )
    expect(() => narrowShellCommandArgs({ ...base, env: { A: 1 } })).toThrow(
      'run_shell_command 的 env.A 必须是字符串，实际收到 number',
    )
  })
})
