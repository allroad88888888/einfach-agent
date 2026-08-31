// 纯参数解析：不碰文件系统、不碰网络、不 listen、不 spawn 浏览器。
//
// 风格照抄 `apps/cli/src/cli-options.ts`（本仓库已有的先例）：手写 switch，不引入
// commander / yargs——这台 server 随后要经 `/api/invoke` 执行 shell 命令，依赖树里
// 每多一个包都是同一份权限的分享者，参数解析这种量级的活不值得为它多背一个包。

export interface ServerCliOptions {
  /** 显示帮助后即退出，不做任何其余的事。 */
  readonly help: boolean
  /** 启动完成后是否自动打开浏览器；`--no-open` 关掉它。 */
  readonly open: boolean
  /** 监听成功后 stdout 是否只输出一行供父进程解析的 JSON。 */
  readonly readyJson: boolean
  /** 绑定地址；不传时由调用方落到 `authLoopback.ts` 的 `DEFAULT_BIND_ADDRESS`。 */
  readonly host?: string
  /** 起始监听端口；不传时由调用方落到 `mainListenRetry.ts` 的 `DEFAULT_START_PORT`。 */
  readonly port?: number
}

export const SERVER_CLI_USAGE = `用法：pnpm serve -- [选项]

选项：
      --port <端口>   起始监听端口（默认 4765；被占用时自动尝试后续端口）。
                      传 0 表示交给系统分配一个空闲端口，常用于测试或脚本。
      --host <地址>   绑定地址（默认 127.0.0.1，只对本机开放；/api/* 的认证与来源校验
                      与绑定地址无关，改这个值不会关掉任何一道防线）
      --no-open       启动后不自动打开浏览器
      --ready-json    以单行 JSON 报告监听地址，并且不自动打开浏览器
  -h, --help          显示此帮助
`

function readValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${option} 需要一个值。`)
  return value
}

function parsePort(raw: string, option: string): number {
  const value = Number(raw)
  // 允许 0（系统分配空闲端口）；其余必须落在合法端口范围内。
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${option} 需要一个 0-65535 之间的整数端口，收到：${raw}`)
  }
  return value
}

/** 解析 argv，不做任何副作用；不合法的输入抛错，由调用方决定怎么回报。 */
export function parseServerCliOptions(argv: readonly string[]): ServerCliOptions {
  const options: { help: boolean; open: boolean; readyJson: boolean; host?: string; port?: number } = {
    help: false,
    open: true,
    readyJson: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      // pnpm run 会把 `--` 分隔符本身透传进 argv，按 apps/cli 的惯例忽略。
      case '--':
        continue
      case '--port':
        options.port = parsePort(readValue(argv, index, argument), argument)
        index += 1
        break
      case '--host':
        options.host = readValue(argv, index, argument)
        index += 1
        break
      case '--no-open':
        options.open = false
        break
      case '--ready-json':
        options.readyJson = true
        options.open = false
        break
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        throw new Error(`未知选项：${argument}。使用 --help 查看用法。`)
    }
  }

  return options
}
