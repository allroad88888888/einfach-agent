export interface CliOptions {
  configPath?: string
  help: boolean
  prompt?: string
  verbose: boolean
  workspaceRoot: string
}

export const CLI_USAGE = `用法：pnpm cli -- [选项]

选项：
  -p, --prompt <文本>       运行一轮后退出
  -w, --workspace <目录>    工具与项目 skills 的工作区（默认：当前目录）
      --config <文件>       凭证配置文件（默认：~/.webAgent/config.json）
  -v, --verbose             将 trace 与性能诊断输出到 stderr
  -h, --help                显示此帮助
`

function readValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) throw new Error(`${option} 需要一个值。`)
  return value
}

/** Parses the CLI surface without performing any filesystem or network work. */
export function parseCliOptions(argv: readonly string[], cwd: string): CliOptions {
  const options: CliOptions = { help: false, verbose: false, workspaceRoot: cwd }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      // pnpm run 会把 `--` 分隔符本身透传进 argv，按惯例忽略。
      case '--':
        continue
      case '-p':
      case '--prompt':
        options.prompt = readValue(argv, index, argument)
        index += 1
        break
      case '-w':
      case '--workspace':
        options.workspaceRoot = readValue(argv, index, argument)
        index += 1
        break
      case '--config':
        options.configPath = readValue(argv, index, argument)
        index += 1
        break
      case '-v':
      case '--verbose':
        options.verbose = true
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
