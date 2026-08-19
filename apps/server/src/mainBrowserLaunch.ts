// 启动后自动打开浏览器——**本卡唯一会 spawn 外部进程的地方**，两条纪律都在这：
//
// 【URL 当参数传，不拼进 shell 字符串】
// `spawn(command, args)` 而不是 `exec(`open ${url}`)`。URL 里带 token：拼进 shell 会让它整串出现
// 在 `ps` 输出与 shell 历史里，且 URL 里任何字符都可能被 shell 重新解释成命令的一部分
// （典型是 `&`——`http://…?a=1&b=2` 在 shell 里会被切成后台任务分隔符）。`spawn` 不经过 shell，
// 参数原样传给目标进程的 argv，没有这两个问题。
//
// 【打不开不能让服务崩溃】
// headless / SSH / 容器环境本来就没有浏览器，`xdg-open` 之类命令可能压根不存在。失败只通过
// `onError` 回调通知调用方打一行提示，绝不抛出、绝不让进程带着非零退出码退出——服务本身仍在跑，
// 用户仍能照打印出来的 URL 手动访问。
//
// 【可测性】`resolveBrowserLaunchCommand` 是纯函数（平台 → 命令），`openBrowser` 接受注入的
// `spawnImpl`，测试永远不传真正的 `node:child_process.spawn`，见同目录 `.test.ts`。

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

export interface BrowserLaunchCommand {
  readonly command: string
  readonly args: readonly string[]
  /** 与 `{ stdio: 'ignore', detached: true }` 合并的额外 spawn 选项；多数平台不需要。 */
  readonly spawnOptions?: SpawnOptions
}

/** 按平台选出打开默认浏览器的命令。纯函数，不做任何 IO。 */
export function resolveBrowserLaunchCommand(url: string, platform: NodeJS.Platform): BrowserLaunchCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] }
    case 'win32':
      // `start` 是 cmd.exe 的内置命令，不是独立可执行文件，必须经 `cmd /c` 调用。
      // 前面的 `""` 占 `start` 的窗口标题参数——不给这个占位，`start` 会把 URL 本身当成标题，
      // 一旦 URL 带 `&` 之类字符（我们的 URL 恒带 `?token=…`，理论上也可能出现）解析就会走样。
      // `windowsVerbatimArguments: true`：Node 默认按 MSVCRT 的规则给参数加转义引号，但 cmd.exe
      // 对 `/c` 之后的整行有自己的一套解析规则、不认那套转义，两者不匹配会让 `""` 被转义成
      // `\"\"` 之类字面量传进去。这个选项让 Node 把 args 原样拼接、不做二次转义。
      return { command: 'cmd', args: ['/c', 'start', '""', url], spawnOptions: { windowsVerbatimArguments: true } }
    default:
      // linux 及其余类 unix 平台统一走 xdg-open；不存在时由下面 spawn 的 'error' 事件兜底。
      return { command: 'xdg-open', args: [url] }
  }
}

export interface OpenBrowserOptions {
  /** 默认 `process.platform`；测试用它固定平台，不依赖跑测试的机器是什么系统。 */
  readonly platform?: NodeJS.Platform
  /** 默认真正的 `node:child_process.spawn`；测试传桩，**绝不能让测试真的打开浏览器**。 */
  readonly spawnImpl?: typeof spawn
  /** 打开失败（同步抛出或子进程 `'error'` 事件）时的回调；默认什么都不做。 */
  readonly onError?: (error: unknown) => void
}

/** 尝试打开浏览器；失败只经 `onError` 通知，不抛出、不影响调用方的控制流。 */
export function openBrowser(url: string, options: OpenBrowserOptions = {}): void {
  const platform = options.platform ?? process.platform
  const spawnImpl = options.spawnImpl ?? spawn
  const onError = options.onError ?? (() => {})
  const { command, args, spawnOptions } = resolveBrowserLaunchCommand(url, platform)

  try {
    const child: ChildProcess = spawnImpl(command, args, { stdio: 'ignore', detached: true, ...spawnOptions })
    child.on('error', onError)
    // detached 的子进程若一直存活会拖着我们的进程不退出；这里的打开器命令
    // （open / xdg-open / cmd start）本身都会立刻返回，unref 只是让这条关系不构成阻塞的保证。
    child.unref()
  } catch (error) {
    // 命令本身不存在时，某些平台 spawn 会同步抛而不是走 'error' 事件（因平台/Node 版本而异），
    // 两条路径都要接住。
    onError(error)
  }
}
