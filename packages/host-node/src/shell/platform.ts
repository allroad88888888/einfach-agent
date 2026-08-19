// 目标平台校验、宿主 shell 选择与 cwd 解析
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/shell_platform.rs（已随 T1 删除）。错误文案保持英文原文——同一次失败，
// 桌面宿主和 Node 宿主必须对模型说同一句话。
//
// 唯一无法逐字对齐的是嵌进文案里的**系统错误描述**（`{err}`）：Rust 的 io::Error 印成
// `No such file or directory (os error 2)`，Node 印成 `ENOENT: no such file or directory,
// stat '/x'`。外层措辞（``cwd `X` is not accessible: ``）逐字相同，内层由各自的运行时决定。

import { realpath, stat } from 'node:fs/promises'
import { errorText } from '../workspace/common'
import { ShellSetupError, type ShellSpec } from './types'

/** core 的 `ShellPlatform`（tools/types.ts）三值域。这里不 import core 的类型：本包不依赖它的运行时，也没必要为一个三值 union 建依赖。 */
export type SupportedPlatform = 'macos' | 'linux' | 'windows'

/** 校验调用方声明的目标平台。非法值不是崩溃，是一次 stderr 写着原因的失败结果。 */
export function parsePlatform(platform: string): SupportedPlatform {
  if (platform === 'macos' || platform === 'linux' || platform === 'windows') return platform
  throw new ShellSetupError(
    `unsupported platform \`${platform}\`; expected \`macos\`, \`linux\`, or \`windows\``,
  )
}

/**
 * 本机平台，多一个 `'unsupported'`。这是**声明**用的形状：S5 之后它同时被握手
 * （`apps/server` 的 `/api/health`）与 CLI 装配拿去告诉 core「这台机器是什么平台」，
 * 一个开区间的 `string` 会让那两处各自去猜哪些值算合法。
 */
export type CurrentPlatform = SupportedPlatform | 'unsupported'

/**
 * 本机平台。对齐 Rust 的 `current_platform()`：认不出的平台回 `"unsupported"`，
 * 于是任何 requested 都会与它不符，命令在 platform mismatch 那一步就停住。
 *
 * 【S5：它同时是握手回报的那个值】下面 `executeShellCommand` 拿它做 platform mismatch 的
 * 判据，而 core 侧「告诉模型本机是什么平台」用的必须是**同一个函数的答案**，否则模型按 A 平台
 * 组命令、这里按 B 平台拒绝。所以它被提到了包的公开面上（`src/index.ts` 的 `nodeHostPlatform`），
 * 宿主装配层握手时直接报它，不另写一份 `process.platform` 映射。
 */
export function currentPlatform(): CurrentPlatform {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'linux') return 'linux'
  if (process.platform === 'win32') return 'windows'
  return 'unsupported'
}

/**
 * 平台 → shell 规格。三个分支与 Rust 逐字一致：
 *   · macos   —— `/bin/zsh -lc`（系统自带，不做存在性检查）
 *   · linux   —— `/bin/bash -lc`，没有就退到 `/bin/sh -lc`，都没有才失败
 *   · windows —— `powershell.exe -NoLogo -NoProfile -NonInteractive -Command`
 *
 * Linux 的存在性检查用异步 `stat` 而不是 `existsSync`：这张路由表要挂在 HTTP 服务后面，
 * 同步文件 IO 会卡住整个事件循环。判据（先 bash 后 sh）与 Rust 相同。
 */
export async function resolveShell(platform: SupportedPlatform): Promise<ShellSpec> {
  if (platform === 'macos') {
    return { program: '/bin/zsh', args: ['-lc'], display: '/bin/zsh -lc' }
  }
  if (platform === 'windows') {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']
    return { program: 'powershell.exe', args, display: `powershell.exe ${args.join(' ')}` }
  }
  if (await pathExists('/bin/bash')) {
    return { program: '/bin/bash', args: ['-lc'], display: '/bin/bash -lc' }
  }
  if (await pathExists('/bin/sh')) {
    return { program: '/bin/sh', args: ['-lc'], display: '/bin/sh -lc' }
  }
  throw new ShellSetupError('no supported Linux shell found: expected `/bin/bash` or `/bin/sh`')
}

/**
 * 解析并校验 cwd，返回 canonicalize 之后的绝对路径。
 *
 * 三条判据依次是「可访问」「是目录」「能 canonicalize」，逐条对齐 Rust。canonicalize 不是
 * 美化：macOS 的 `/var` 是指向 `/private/var` 的软链，子进程 `pwd` 打出来的是后者，结果里
 * 回显前者的话，调用方拿到的 cwd 与命令实际所在的目录对不上。
 *
 * **注意这里没有 workspace confinement**：shell 命令本来就允许在 workspace 之外跑
 * （Rust 侧同样如此），限制它的是工具层的确认流程，不是这一层。
 */
export async function resolveCwd(cwd: string | undefined): Promise<string> {
  if (cwd !== undefined && cwd.trim() === '') throw new ShellSetupError('cwd cannot be empty')
  const target = cwd ?? currentDirectory()

  try {
    const stats = await stat(target)
    if (!stats.isDirectory()) throw new ShellSetupError(`cwd \`${target}\` is not a directory`)
  } catch (error) {
    if (error instanceof ShellSetupError) throw error
    throw new ShellSetupError(`cwd \`${target}\` is not accessible: ${errorText(error)}`)
  }

  try {
    return await realpath(target)
  } catch (error) {
    throw new ShellSetupError(`failed to resolve cwd \`${target}\`: ${errorText(error)}`)
  }
}

/** 进程当前目录。`process.cwd()` 在目录已被删除时会抛，Rust 的 `env::current_dir()` 同样会失败。 */
function currentDirectory(): string {
  try {
    return process.cwd()
  } catch (error) {
    throw new ShellSetupError(`failed to read current directory: ${errorText(error)}`)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
