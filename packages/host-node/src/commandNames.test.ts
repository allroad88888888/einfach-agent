import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NODE_HOST_COMMANDS_BY_DOMAIN,
  NODE_HOST_COMMAND_NAMES,
  isNodeHostCommandName,
} from './commandNames'

// 命令全集的**上游权威**：桌面宿主 `invoke_handler(tauri::generate_handler![...])` 的登记列表。
// 本文件逐字比对两边，堵住「Rust 侧加了命令、Node 侧永远不知道该实现它」这种静默漂移——
// 那种漂移的症状只是某个功能在浏览器版里没反应，既不报错也不指向病因。
// 从 cwd 往上找 pnpm-workspace.yaml 定位仓库根。**不能用 `import.meta.url`**：Vitest 走 Vite
// 的模块图，jsdom 环境下 `import.meta.url` 是 http:// 而不是 file://，`fileURLToPath` 当场抛
// 「The URL must be of scheme file」。
function repositoryRoot(): string {
  let current = process.cwd()
  while (!existsSync(join(current, 'pnpm-workspace.yaml'))) {
    const parent = dirname(current)
    expect(parent, '从 cwd 往上找不到 pnpm-workspace.yaml').not.toBe(current)
    current = parent
  }
  return current
}

const desktopLibPath = resolve(repositoryRoot(), 'apps/desktop/src/lib.rs')

function commandsRegisteredByDesktopHost(): string[] {
  const source = readFileSync(desktopLibPath, 'utf8')
  const start = source.indexOf('tauri::generate_handler![')
  expect(start, 'apps/desktop/src/lib.rs 里找不到 generate_handler! 登记块').toBeGreaterThan(-1)
  const end = source.indexOf(']', start)
  const block = source.slice(start, end)
  // 每条形如 `module_name::command_name,`，取第二段。
  return [...block.matchAll(/(\w+)::(\w+)\s*,/g)].map((match) => match[2])
}

// 没有 Rust 对应物的域：桌面侧的等价能力由 Tauri **插件**提供，从来不在 lib.rs 的
// `generate_handler!` 里，所以它们不参与上面那份逐字比对。**排除的是整域、且要点名**——
// 换成「放宽比对口径」（比如只查子集）的话，Rust 侧真的新增一条而这里没跟上时就再也没人报信，
// 而那正是这份测试存在的唯一理由。
const DOMAINS_WITHOUT_DESKTOP_COMMANDS = ['sqlite'] as const

function commandsWithDesktopCounterpart(): string[] {
  return Object.entries(NODE_HOST_COMMANDS_BY_DOMAIN)
    .filter(([domain]) => !(DOMAINS_WITHOUT_DESKTOP_COMMANDS as readonly string[]).includes(domain))
    .flatMap(([, commands]) => [...commands])
}

describe('命令全集', () => {
  it('与桌面宿主登记的命令逐字一致（sqlite 域除外，它没有 Rust 对应物）', () => {
    const registered = commandsRegisteredByDesktopHost()
    expect([...registered].sort()).toEqual([...commandsWithDesktopCounterpart()].sort())
  })

  it('sqlite 域是 Node 独有的两条，且确实不在桌面宿主的登记列表里', () => {
    // 反向钉一次：万一哪天 Rust 侧真的加了同名命令，上一条用例只会说「多了两条」，
    // 而病因（两个宿主对同一个名字各有一份实现）要靠这条说出来。
    expect(NODE_HOST_COMMANDS_BY_DOMAIN.sqlite).toEqual(['sqlite_execute', 'sqlite_select'])
    const registered = new Set(commandsRegisteredByDesktopHost())
    for (const command of NODE_HOST_COMMANDS_BY_DOMAIN.sqlite) {
      expect(registered.has(command)).toBe(false)
    }
  })

  it('恰好 30 条（28 条对应 Rust 命令 + sqlite 域 2 条），且没有重复', () => {
    expect(NODE_HOST_COMMAND_NAMES).toHaveLength(30)
    expect(new Set(NODE_HOST_COMMAND_NAMES).size).toBe(30)
  })

  it('域之间不共享命令名——一条命令只能有一个实现目录', () => {
    const seen = new Map<string, string>()
    for (const [domain, commands] of Object.entries(NODE_HOST_COMMANDS_BY_DOMAIN)) {
      for (const command of commands) {
        expect(seen.get(command), `${command} 同时登记在 ${seen.get(command)} 与 ${domain}`)
          .toBeUndefined()
        seen.set(command, domain)
      }
    }
  })

  it('isNodeHostCommandName 对全集内为真、对近似名为假', () => {
    for (const command of NODE_HOST_COMMAND_NAMES) expect(isNodeHostCommandName(command)).toBe(true)
    expect(isNodeHostCommandName('read_workspace_fil')).toBe(false)
    expect(isNodeHostCommandName('readWorkspaceFile')).toBe(false)
    // 不能被 Object.prototype 上的键蒙混过去（Set 判定天然安全，这条钉住它不被改成对象查表）。
    expect(isNodeHostCommandName('toString')).toBe(false)
    expect(isNodeHostCommandName('constructor')).toBe(false)
  })
})
