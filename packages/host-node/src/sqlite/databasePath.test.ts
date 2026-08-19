import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSqliteDatabasePath, sqliteDataDirectory } from './databasePath'

const HOME = '/srv/agent-home'

describe('sqliteDataDirectory', () => {
  it('macOS 走 Library/Application Support，不看环境变量', () => {
    expect(sqliteDataDirectory(HOME, 'darwin', { XDG_DATA_HOME: '/xdg', APPDATA: '/appdata' })).toBe(
      posix.join(HOME, 'Library', 'Application Support'),
    )
  })

  it('Windows 取 %APPDATA%，缺失时回落 AppData/Roaming', () => {
    expect(sqliteDataDirectory(HOME, 'win32', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' })).toBe(
      'C:\\Users\\x\\AppData\\Roaming',
    )
    // 路径语义也跟着参数走：win32 分支拼出来的是反斜杠，本机是不是 Windows 无关。
    expect(sqliteDataDirectory(HOME, 'win32', {})).toBe(win32.join(HOME, 'AppData', 'Roaming'))
  })

  it('Linux 取 XDG_DATA_HOME，但**必须是绝对路径**，否则回落 ~/.local/share', () => {
    // 判据逐字对齐 Rust `dirs` crate：
    // `env::var_os("XDG_DATA_HOME").and_then(dirs_sys::is_absolute_path)`。
    // 仓库里另一份同款实现（vite.config.ts 的 defaultTraceDbPath）用的是 `??`，两条都漏了：
    // 相对值会被当成有效值，空串也一样，`path.join('', …)` 于是变成跟着进程 cwd 走的相对路径。
    expect(sqliteDataDirectory(HOME, 'linux', { XDG_DATA_HOME: '/xdg/data' })).toBe('/xdg/data')
    expect(sqliteDataDirectory(HOME, 'linux', { XDG_DATA_HOME: 'relative/data' })).toBe(
      posix.join(HOME, '.local', 'share'),
    )
    expect(sqliteDataDirectory(HOME, 'linux', { XDG_DATA_HOME: '' })).toBe(
      posix.join(HOME, '.local', 'share'),
    )
    expect(sqliteDataDirectory(HOME, 'linux', {})).toBe(posix.join(HOME, '.local', 'share'))
  })
})

describe('resolveSqliteDatabasePath', () => {
  const savedConfigDir = process.env.WEB_AGENT_CONFIG_DIR

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.WEB_AGENT_CONFIG_DIR
    else process.env.WEB_AGENT_CONFIG_DIR = savedConfigDir
  })

  it('默认落在桌面版同一个位置：<应用数据目录>/com.webagent.app/web-agent.db', () => {
    // 判据是「两个宿主看到同一份会话」：套壳之前的窗口期里桌面版与浏览器自托管版会交替使用，
    // 会话落进两个文件 = 用户看到两份互不相干的历史，而这不会报错。
    const path = resolveSqliteDatabasePath({ homeDir: HOME })
    const expectedDataDirectory = sqliteDataDirectory(HOME, process.platform, process.env)
    expect(path).toBe(join(expectedDataDirectory, 'com.webagent.app', 'web-agent.db'))
  })

  it('不传 homeDir 时回落 os.homedir()（与 config 域同一个权威）', () => {
    const path = resolveSqliteDatabasePath({})
    expect(path.startsWith(sqliteDataDirectory(homedir(), process.platform, process.env))).toBe(true)
  })

  it('**不**跟随 WEB_AGENT_CONFIG_DIR', () => {
    // 那个环境变量的语义是「选配置目录」，在 Rust 侧同样只作用于配置存储、对 SQL 插件的库路径
    // 没有影响。让它顺带搬走库文件，等于让同一个开关在两个宿主上做不同的事——而「同一份会话」
    // 这条判据恰好会在最需要它的场景（用户开了隔离配置）失效。
    const withoutOverride = resolveSqliteDatabasePath({ homeDir: HOME })
    process.env.WEB_AGENT_CONFIG_DIR = '/tmp/some-isolated-config'
    expect(resolveSqliteDatabasePath({ homeDir: HOME })).toBe(withoutOverride)
  })

  it('装配槽 databasePath 覆盖默认位置，相对路径受控失败', () => {
    expect(resolveSqliteDatabasePath({ homeDir: HOME, databasePath: '/data/custom.db' })).toBe(
      '/data/custom.db',
    )
    // 空白等同没配置（同 homeDir 的口径）。
    expect(resolveSqliteDatabasePath({ homeDir: HOME, databasePath: '   ' })).toBe(
      resolveSqliteDatabasePath({ homeDir: HOME }),
    )
    // 按 cwd 解析的后果是同一份配置在不同工作目录下开出不同的库，症状同样是「会话不见了」。
    expect(() => resolveSqliteDatabasePath({ homeDir: HOME, databasePath: 'custom.db' })).toThrow(
      /必须是绝对路径/,
    )
  })
})
