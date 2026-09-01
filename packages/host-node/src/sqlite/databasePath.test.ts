import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAppDataDirectory } from '../appDataPath'
import { resolveSqliteDatabasePath } from './databasePath'

const HOME = '/srv/agent-home'

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
    const expectedAppDataDirectory = resolveAppDataDirectory({
      homeDirectory: HOME,
      platform: process.platform,
      env: process.env,
    })
    expect(path).toBe(join(expectedAppDataDirectory, 'web-agent.db'))
  })

  it('不传 homeDir 时回落 os.homedir()（与 config 域同一个权威）', () => {
    const path = resolveSqliteDatabasePath({})
    expect(
      path.startsWith(
        resolveAppDataDirectory({ homeDirectory: homedir(), platform: process.platform, env: process.env }),
      ),
    ).toBe(true)
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
