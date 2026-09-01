import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveAppDataDirectory } from './appDataPath'

const HOME = '/srv/agent-home'

describe('resolveAppDataDirectory', () => {
  it.each([
    [
      'darwin',
      { platform: 'darwin', homeDirectory: HOME },
      posix.join(HOME, 'Library', 'Application Support', 'com.webagent.app'),
    ],
    [
      'win32 APPDATA',
      { platform: 'win32', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' } },
      'C:\\Users\\x\\AppData\\Roaming\\com.webagent.app',
    ],
    [
      'win32 fallback',
      { platform: 'win32', env: {}, homeDirectory: HOME },
      win32.join(HOME, 'AppData', 'Roaming', 'com.webagent.app'),
    ],
    ['linux XDG', { platform: 'linux', env: { XDG_DATA_HOME: '/xdg/data' } }, '/xdg/data/com.webagent.app'],
    [
      'linux fallback',
      { platform: 'linux', env: { XDG_DATA_HOME: 'relative/data' }, homeDirectory: HOME },
      posix.join(HOME, '.local', 'share', 'com.webagent.app'),
    ],
    [
      'custom directory',
      { platform: 'win32', env: {}, customDirectory: 'D:\\agent-data' },
      win32.join('D:\\agent-data', 'com.webagent.app'),
    ],
  ] as const)('%s resolves the application directory', (_name, input, expected) => {
    expect(resolveAppDataDirectory(input)).toBe(expected)
  })

  it('rejects missing injected inputs without consulting the process environment', () => {
    expect(() => resolveAppDataDirectory({ platform: 'linux', env: {} })).toThrow(
      /platform=linux.*homeDirectory/,
    )
    expect(() => resolveAppDataDirectory({ platform: 'win32', homeDirectory: HOME })).toThrow(
      /platform=win32.*env/,
    )
  })
})
