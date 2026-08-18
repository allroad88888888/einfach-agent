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

describe('命令全集', () => {
  it('与桌面宿主登记的命令逐字一致', () => {
    const registered = commandsRegisteredByDesktopHost()
    expect([...registered].sort()).toEqual([...NODE_HOST_COMMAND_NAMES].sort())
  })

  it('恰好 28 条，且没有重复', () => {
    expect(NODE_HOST_COMMAND_NAMES).toHaveLength(28)
    expect(new Set(NODE_HOST_COMMAND_NAMES).size).toBe(28)
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
