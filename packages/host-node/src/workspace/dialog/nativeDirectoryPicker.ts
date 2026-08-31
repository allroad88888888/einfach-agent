// macOS 系统目录选择器。
// ---------------------------------------------------------------------------
// Node 没有跨平台的目录 chooser；桌面端在 macOS 上通过 osascript 调用系统的 choose folder，
// 不经 shell 字符串拼接，因此用户选择的路径不会被解释为命令。

import { execFile } from 'node:child_process'

const CHOOSE_DIRECTORY_SCRIPT = 'POSIX path of (choose folder with prompt "选择工作区目录")'
const MAX_OUTPUT_BYTES = 64 * 1024

export type AppleScriptRunner = (script: string) => Promise<string>
export type WorkspaceDirectoryPicker = () => Promise<string | undefined>

function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

function wasCancelled(error: unknown): boolean {
  return /\(-128\)|user canceled|用户取消/i.test(errorText(error))
}

/** Opens macOS's native directory chooser and returns undefined when the user cancels it. */
export async function pickNativeWorkspaceDirectory(
  options: { platform?: NodeJS.Platform; runAppleScript?: AppleScriptRunner } = {},
): Promise<string | undefined> {
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new Error('系统目录选择目前仅支持 macOS；请手动输入工作区路径。')
  }

  try {
    const selected = (await (options.runAppleScript ?? runAppleScript)(CHOOSE_DIRECTORY_SCRIPT)).trim()
    return selected || undefined
  } catch (error) {
    if (wasCancelled(error)) return undefined
    throw error
  }
}
