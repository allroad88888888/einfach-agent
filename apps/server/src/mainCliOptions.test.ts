import { describe, expect, it } from 'vitest'
import { parseServerCliOptions, SERVER_CLI_USAGE } from './mainCliOptions'

describe('parseServerCliOptions', () => {
  it('默认：帮助关、自动打开浏览器开、host/port 都不传', () => {
    expect(parseServerCliOptions([])).toEqual({ help: false, open: true })
  })

  it('--no-open 关掉自动打开浏览器', () => {
    expect(parseServerCliOptions(['--no-open']).open).toBe(false)
  })

  it('--port 解析为数字', () => {
    expect(parseServerCliOptions(['--port', '5000']).port).toBe(5000)
  })

  it('--port 0 合法（交给系统分配空闲端口）', () => {
    expect(parseServerCliOptions(['--port', '0']).port).toBe(0)
  })

  it('--port 非法值报错：非数字、越界、非整数', () => {
    expect(() => parseServerCliOptions(['--port', 'abc'])).toThrow('--port 需要一个 0-65535 之间的整数端口')
    expect(() => parseServerCliOptions(['--port', '70000'])).toThrow(/0-65535/)
    expect(() => parseServerCliOptions(['--port', '1.5'])).toThrow(/0-65535/)
  })

  it('--port -1：`-` 开头的值先被 readValue 当成「缺值」拦下，不会走到范围校验', () => {
    // 与 apps/cli 的 readValue 同一约定：值不能以 `-` 开头，否则没法区分
    // 「用户忘了给值、下一个 token 其实是另一个选项」与「值本身就是负数」。
    // 负端口号本来就不合法，这里只是报错文案落在缺值分支而不是范围分支。
    expect(() => parseServerCliOptions(['--port', '-1'])).toThrow('--port 需要一个值。')
  })

  it('--host 原样存下', () => {
    expect(parseServerCliOptions(['--host', '0.0.0.0']).host).toBe('0.0.0.0')
  })

  it('-h / --help 都能命中', () => {
    expect(parseServerCliOptions(['-h']).help).toBe(true)
    expect(parseServerCliOptions(['--help']).help).toBe(true)
  })

  it('缺值报错：--port / --host 后面没有值，或紧跟着另一个选项', () => {
    expect(() => parseServerCliOptions(['--port'])).toThrow('--port 需要一个值。')
    expect(() => parseServerCliOptions(['--host'])).toThrow('--host 需要一个值。')
    expect(() => parseServerCliOptions(['--port', '--host'])).toThrow('--port 需要一个值。')
  })

  it('未知选项报错，并提示 --help', () => {
    expect(() => parseServerCliOptions(['--wat'])).toThrow('未知选项：--wat。使用 --help 查看用法。')
  })

  it('单独的 -- 分隔符被忽略（pnpm run 会原样透传）', () => {
    expect(parseServerCliOptions(['--', '--no-open'])).toEqual({ help: false, open: false })
  })

  it('多个选项可以组合，后出现的同名选项覆盖先出现的', () => {
    const options = parseServerCliOptions(['--port', '3000', '--host', 'localhost', '--no-open', '--port', '4000'])
    expect(options).toEqual({ help: false, open: false, host: 'localhost', port: 4000 })
  })
})

describe('SERVER_CLI_USAGE', () => {
  it('每个选项都在用法文本里说清楚了', () => {
    expect(SERVER_CLI_USAGE).toContain('--port')
    expect(SERVER_CLI_USAGE).toContain('--host')
    expect(SERVER_CLI_USAGE).toContain('--no-open')
    expect(SERVER_CLI_USAGE).toContain('--help')
    expect(SERVER_CLI_USAGE).toContain('4765')
    expect(SERVER_CLI_USAGE).toContain('127.0.0.1')
  })
})
