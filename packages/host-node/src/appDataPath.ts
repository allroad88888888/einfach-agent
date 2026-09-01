import { posix, win32 } from 'node:path'

const APPLICATION_IDENTIFIER = 'com.webagent.app'

export interface AppDataDirectoryInput {
  readonly customDirectory?: string
  readonly env?: NodeJS.ProcessEnv
  readonly homeDirectory?: string
  readonly platform: NodeJS.Platform
}

/** Resolves the application-owned directory below an explicitly supplied data root. */
export function resolveAppDataDirectory(input: AppDataDirectoryInput): string {
  const paths = input.platform === 'win32' ? win32 : posix
  const customDirectory = input.customDirectory?.trim()
  if (customDirectory) {
    if (!paths.isAbsolute(customDirectory)) {
      throw new Error(`无法解析 application-data 目录（platform=${input.platform}）：customDirectory 必须是绝对路径`)
    }
    return paths.join(customDirectory, APPLICATION_IDENTIFIER)
  }

  if (input.platform === 'darwin') {
    return paths.join(requireHomeDirectory(input), 'Library', 'Application Support', APPLICATION_IDENTIFIER)
  }
  const env = requireEnvironment(input)
  if (input.platform === 'win32') {
    const roaming = env.APPDATA
    if (roaming && paths.isAbsolute(roaming)) return paths.join(roaming, APPLICATION_IDENTIFIER)
    return paths.join(requireHomeDirectory(input), 'AppData', 'Roaming', APPLICATION_IDENTIFIER)
  }
  const xdgDataHome = env.XDG_DATA_HOME
  if (xdgDataHome && paths.isAbsolute(xdgDataHome)) return paths.join(xdgDataHome, APPLICATION_IDENTIFIER)
  return paths.join(requireHomeDirectory(input), '.local', 'share', APPLICATION_IDENTIFIER)
}

function requireEnvironment(input: AppDataDirectoryInput): NodeJS.ProcessEnv {
  if (input.env) return input.env
  return missingInput(input.platform, 'env')
}

function requireHomeDirectory(input: AppDataDirectoryInput): string {
  const homeDirectory = input.homeDirectory?.trim()
  if (homeDirectory) return homeDirectory
  return missingInput(input.platform, 'homeDirectory')
}

function missingInput(platform: NodeJS.Platform, field: 'env' | 'homeDirectory'): never {
  throw new Error(`无法解析 application-data 目录（platform=${platform}）：缺失 ${field}`)
}
