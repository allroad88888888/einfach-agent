import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { currentPlatform, parsePlatform, resolveCwd, resolveShell } from './platform'
import { ShellSetupError } from './types'

let tempDir: string

beforeEach(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'host-node-shell-platform-')))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('parsePlatform', () => {
  it('只认三个值', () => {
    expect(parsePlatform('macos')).toBe('macos')
    expect(parsePlatform('linux')).toBe('linux')
    expect(parsePlatform('windows')).toBe('windows')
  })

  it('其余一律是准备阶段失败，文案与桌面端逐字相同', () => {
    // 文案是模型直接读到的那句话，两个宿主必须说同一句；这里锁死它。
    expect(() => parsePlatform('darwin')).toThrow(ShellSetupError)
    expect(() => parsePlatform('darwin')).toThrow(
      'unsupported platform `darwin`; expected `macos`, `linux`, or `windows`',
    )
  })
})

describe('currentPlatform', () => {
  it('把 process.platform 映射成 core 的三值域', () => {
    const expected =
      process.platform === 'darwin'
        ? 'macos'
        : process.platform === 'linux'
          ? 'linux'
          : process.platform === 'win32'
            ? 'windows'
            : 'unsupported'

    expect(currentPlatform()).toBe(expected)
  })
})

describe('resolveShell', () => {
  it('macOS 固定用 /bin/zsh -lc', async () => {
    await expect(resolveShell('macos')).resolves.toEqual({
      program: '/bin/zsh',
      args: ['-lc'],
      display: '/bin/zsh -lc',
    })
  })

  it('Windows 用 PowerShell，且四个开关的顺序进 display', async () => {
    await expect(resolveShell('windows')).resolves.toEqual({
      program: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'],
      display: 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command',
    })
  })

  it('Linux 优先 /bin/bash，退而求其次 /bin/sh', async () => {
    // 本机可能是 macOS（没有 /bin/bash 也照样有 /bin/sh），所以只断言「落在这两个里」。
    const shell = await resolveShell('linux')

    expect(['/bin/bash', '/bin/sh']).toContain(shell.program)
    expect(shell.display).toBe(`${shell.program} -lc`)
  })
})

describe('resolveCwd', () => {
  it('不传时用进程当前目录（canonicalize 之后）', async () => {
    await expect(resolveCwd(undefined)).resolves.toBe(await realpath(process.cwd()))
  })

  it('空白字符串是非法，不是「没传」', async () => {
    await expect(resolveCwd('')).rejects.toThrow('cwd cannot be empty')
    await expect(resolveCwd('  \t ')).rejects.toThrow('cwd cannot be empty')
  })

  it('canonicalize：软链解成真实路径', async () => {
    // 结果里回显的 cwd 必须与子进程 `pwd` 打出来的一致，否则调用方按回显的路径再拼路径会错。
    const link = join(tempDir, 'link')
    await symlink(tempDir, link)

    await expect(resolveCwd(link)).resolves.toBe(tempDir)
  })

  it('不存在的目录报 not accessible', async () => {
    const missing = join(tempDir, 'nope')

    await expect(resolveCwd(missing)).rejects.toThrow(`cwd \`${missing}\` is not accessible`)
  })
})
