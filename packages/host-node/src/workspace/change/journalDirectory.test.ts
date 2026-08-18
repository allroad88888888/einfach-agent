import { describe, expect, it } from 'vitest'
import { appDataDirectory, journalDirectory } from './journalDirectory'
import type { AppDataFacts } from './journalDirectory'

function facts(overrides: Partial<AppDataFacts>): AppDataFacts {
  return { platform: 'linux', env: {}, homeDir: '/home/alice', ...overrides }
}

describe('appDataDirectory', () => {
  it('macOS：$HOME/Library/Application Support/<identifier>', () => {
    expect(appDataDirectory(facts({ platform: 'darwin', homeDir: '/Users/alice' }))).toBe(
      '/Users/alice/Library/Application Support/com.webagent.app',
    )
  })

  it('Windows：%APPDATA%/<identifier>', () => {
    expect(
      appDataDirectory(
        facts({
          platform: 'win32',
          homeDir: 'C:\\Users\\Alice',
          env: { APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming' },
        }),
      ),
    ).toBe('C:\\Users\\Alice\\AppData\\Roaming\\com.webagent.app')
  })

  it('Windows：APPDATA 缺失时回落到 <home>/AppData/Roaming', () => {
    expect(appDataDirectory(facts({ platform: 'win32', homeDir: 'C:\\Users\\Alice' }))).toBe(
      'C:\\Users\\Alice\\AppData\\Roaming\\com.webagent.app',
    )
  })

  it('Linux：默认 $HOME/.local/share/<identifier>', () => {
    expect(appDataDirectory(facts({}))).toBe('/home/alice/.local/share/com.webagent.app')
  })

  it('Linux：绝对路径的 XDG_DATA_HOME 生效', () => {
    expect(appDataDirectory(facts({ env: { XDG_DATA_HOME: '/data/xdg' } }))).toBe(
      '/data/xdg/com.webagent.app',
    )
  })

  it.each([
    ['相对路径', '.local/share'],
    ['空串', ''],
  ])('Linux：%s 的 XDG_DATA_HOME 被忽略（dirs 的 is_absolute_path 判定）', (_name, value) => {
    // 这条最容易被「顺手简化」掉：少了绝对路径判定，`XDG_DATA_HOME=.local` 会让日志目录跟着进程
    // cwd 走，同一台机器上两次启动写进两个目录，而且不报错。
    expect(appDataDirectory(facts({ env: { XDG_DATA_HOME: value } }))).toBe(
      '/home/alice/.local/share/com.webagent.app',
    )
  })

  it('平台决定路径分隔符，不跟随当前进程', () => {
    // 在 macOS 上跑 Windows 分支时，若用当前进程的 path 模块就会拼出正斜杠，于是测试钉住了一个
    // 生产里不存在的形状。
    expect(appDataDirectory(facts({ platform: 'win32', homeDir: 'C:\\Users\\Alice' }))).toContain(
      '\\',
    )
  })
})

describe('journalDirectory', () => {
  it('三平台都在 app data 目录下接 workspace-changes', () => {
    expect(journalDirectory(facts({ platform: 'darwin', homeDir: '/Users/alice' }))).toBe(
      '/Users/alice/Library/Application Support/com.webagent.app/workspace-changes',
    )
    expect(journalDirectory(facts({}))).toBe(
      '/home/alice/.local/share/com.webagent.app/workspace-changes',
    )
    expect(
      journalDirectory(
        facts({ platform: 'win32', homeDir: 'C:\\Users\\Alice', env: { APPDATA: 'C:\\AD' } }),
      ),
    ).toBe('C:\\AD\\com.webagent.app\\workspace-changes')
  })
})
