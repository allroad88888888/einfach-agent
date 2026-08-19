import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOST_EVENT_NAMES, isHostEventName } from './hostEventNames'
import { HOST_EVENT_PAYLOAD_KEYS } from './hostEventPayloads'

// 事件面的**上游权威**是桌面宿主 `apps/desktop/src/mcp_lifecycle.rs`：那里的两个 `const &str`
// 是线上的事件名，两个 `#[serde(rename_all = "camelCase")]` struct 是线上的载荷形状。
// 本文件逐字对拍，堵住「Rust 侧改了名字/加了字段，Node 侧永远不知道」这种静默漂移——
// 那种漂移的症状是浏览器版里 MCP 服务退出后前端毫无反应，既不报错也不指向病因。
// 口径同 `commandNames.test.ts`（它比对 lib.rs 的 generate_handler! 登记列表）。
//
// 从 cwd 往上找 pnpm-workspace.yaml 定位仓库根。**不能用 `import.meta.url`**：Vitest 走 Vite
// 的模块图，jsdom 环境下它是 http:// 而不是 file://，`fileURLToPath` 当场抛。
function repositoryRoot(): string {
  let current = process.cwd()
  while (!existsSync(join(current, 'pnpm-workspace.yaml'))) {
    const parent = dirname(current)
    expect(parent, '从 cwd 往上找不到 pnpm-workspace.yaml').not.toBe(current)
    current = parent
  }
  return current
}

const lifecycleSourcePath = resolve(repositoryRoot(), 'apps/desktop/src/mcp_lifecycle.rs')

function lifecycleSource(): string {
  return readFileSync(lifecycleSourcePath, 'utf8')
}

/** 取 `const NAME: &str = "…";` 里的字面量，保留书写顺序。 */
function eventNamesEmittedByDesktopHost(source: string): string[] {
  return [...source.matchAll(/const\s+\w+\s*:\s*&str\s*=\s*"([^"]+)"\s*;/g)].map((m) => m[1])
}

/** 取某个 struct 的字段名（`pub(super) server_id: String,` → `server_id`）。 */
function structFields(source: string, structName: string): string[] {
  const declaration = `struct ${structName} {`
  const start = source.indexOf(declaration)
  expect(start, `${lifecycleSourcePath} 里找不到 struct ${structName}`).toBeGreaterThan(-1)
  const end = source.indexOf('}', start)
  const body = source.slice(start + declaration.length, end)
  return [...body.matchAll(/(?:pub(?:\([^)]*\))?\s+)?(\w+)\s*:\s*[^,]+,/g)].map((m) => m[1])
}

function toCamelCase(field: string): string {
  return field.replace(/_([a-z])/g, (_all, letter: string) => letter.toUpperCase())
}

// 事件名 → Rust 载荷 struct。这个对应关系来自 `McpLifecycleEventSink::from_app` 的 match：
// `ToolsChanged(McpLifecycleEventPayload)` 走 TOOLS_CHANGED、`Closed(McpCloseEventPayload)` 走 CLOSE。
// struct 若被改名，下面 `structFields` 找不到就当场红。
const DESKTOP_PAYLOAD_STRUCTS = {
  'mcp-stdio-tools-changed': 'McpLifecycleEventPayload',
  'mcp-stdio-close': 'McpCloseEventPayload',
} as const

describe('宿主事件名', () => {
  it('与桌面宿主 emit 的事件名逐字一致', () => {
    const emitted = eventNamesEmittedByDesktopHost(lifecycleSource())
    expect([...emitted].sort()).toEqual([...HOST_EVENT_NAMES].sort())
  })

  it('恰好两条且没有重复', () => {
    expect(HOST_EVENT_NAMES).toHaveLength(2)
    expect(new Set<string>(HOST_EVENT_NAMES).size).toBe(2)
  })

  it('isHostEventName 对全集内为真、对近似名与原型键为假', () => {
    for (const name of HOST_EVENT_NAMES) expect(isHostEventName(name)).toBe(true)
    // 少一个字母的名字：开放字符串下它是一条永不触发的死订阅，这里必须判假。
    expect(isHostEventName('mcp-stdio-clos')).toBe(false)
    expect(isHostEventName('mcpStdioClose')).toBe(false)
    expect(isHostEventName('')).toBe(false)
    // Set 判定天然不吃 Object.prototype 的键；这两条钉住它不被改成对象查表。
    expect(isHostEventName('toString')).toBe(false)
    expect(isHostEventName('constructor')).toBe(false)
    // 非字符串输入（线上读回来的字段未必是 string）。
    expect(isHostEventName(undefined)).toBe(false)
    expect(isHostEventName(null)).toBe(false)
    expect(isHostEventName(42)).toBe(false)
  })
})

describe('宿主事件载荷', () => {
  it('字段与桌面宿主的 struct 逐字一致（snake_case → camelCase）', () => {
    const source = lifecycleSource()
    for (const [event, structName] of Object.entries(DESKTOP_PAYLOAD_STRUCTS)) {
      const desktopKeys = structFields(source, structName).map(toCamelCase)
      const declaredKeys = HOST_EVENT_PAYLOAD_KEYS[event as keyof typeof DESKTOP_PAYLOAD_STRUCTS]
      expect([...desktopKeys].sort(), `${event} 的载荷字段与 ${structName} 不一致`)
        .toEqual([...declaredKeys].sort())
    }
  })

  it('桌面侧两个载荷 struct 都带 rename_all = "camelCase"', () => {
    // 这条属性一旦被删掉，线上的键会变回 snake_case（`server_id`），而本包声明的仍是 camelCase。
    // 上一条测试比的是「字段集合」，转换规则错了它照样绿——所以规则本身要单独钉。
    const source = lifecycleSource()
    for (const structName of Object.values(DESKTOP_PAYLOAD_STRUCTS)) {
      const start = source.indexOf(`struct ${structName} {`)
      expect(start).toBeGreaterThan(-1)
      const attributes = source.slice(Math.max(0, start - 200), start)
      expect(attributes, `${structName} 上方没有 rename_all = "camelCase"`)
        .toContain('#[serde(rename_all = "camelCase")]')
    }
  })
})
