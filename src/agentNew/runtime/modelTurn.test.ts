// modelTurn.test.ts —— buildTurnTools 的环境过滤（TP3）单测。
// ---------------------------------------------------------------------------
// 契约（TP3）：runtime:'server' 工具依赖 Tauri 本机能力，web 下不进 manifest。
//   · request_tool_schema 的 toolName enum：web(false) 不含 server 工具名、含 internal 工具名；
//     Tauri(true) 含 server 工具名。
//   · visible 展开也按同一判据过滤：web 下即便某 server 工具混进 visible 也不发给 model。
//   · request_tool_schema 元工具本身恒在场（两种 isTauri 都在返回列表首位）。
// 此环境 isTauri() 天然为 false，但这里直接传布尔参数，不依赖真实环境。

import { describe, it, expect } from 'vitest'
import { buildTurnTools } from './modelTurn'
import { toolRegistry } from '../tools/registry'
import type { LoadedTool } from '../tools/types'
import type { ModelFunctionTool } from '../api/modelApi'
import '../tools/register' // 副作用：注册真实内置工具，供 toolRegistry.list() 取真实工具名。

// 从 request_tool_schema 元工具里取 toolName enum（真实 registry 名字）。parameters 类型为 unknown，就地收窄。
function schemaEnum(tools: ModelFunctionTool[]): string[] {
  const params = tools[0].function.parameters as {
    properties: { toolName: { enum?: string[] } }
  }
  return params.properties.toolName.enum ?? []
}

// 真实 registry 里的一个 server 工具名与一个 internal 工具名（改动前先看实际 name）。
const SERVER_TOOL = 'shell_macos'
const SERVER_TOOL_2 = 'read_file'
const INTERNAL_TOOL = 'skill_search'

describe('buildTurnTools —— TP3 server 工具按环境过滤', () => {
  it('request_tool_schema 元工具恒在场（两种 isTauri 都在返回列表首位）', () => {
    for (const isTauri of [false, true]) {
      const tools = buildTurnTools([], isTauri)
      expect(tools[0].function.name).toBe('request_tool_schema')
    }
  })

  it('web(false)：enum 不含任何 server 工具名，含 internal 工具名', () => {
    const names = schemaEnum(buildTurnTools([], false))
    expect(names).not.toContain(SERVER_TOOL)
    expect(names).not.toContain(SERVER_TOOL_2)
    expect(names).toContain(INTERNAL_TOOL)
    // 更强：registry 里所有 server 工具都不在 enum 里。
    const serverNames = toolRegistry
      .list()
      .filter((t) => t.runtime === 'server')
      .map((t) => t.name)
    expect(serverNames.length).toBeGreaterThan(0)
    for (const name of serverNames) {
      expect(names).not.toContain(name)
    }
  })

  it('Tauri(true)：enum 含 server 工具名', () => {
    const names = schemaEnum(buildTurnTools([], true))
    expect(names).toContain(SERVER_TOOL)
    expect(names).toContain(INTERNAL_TOOL)
    // 更强：registry 里所有工具（含 server）都在 enum 里。
    for (const tool of toolRegistry.list()) {
      expect(names).toContain(tool.name)
    }
  })

  it('visible 过滤：server 工具 web 下不进 function 列表、Tauri 下进', () => {
    const fakeServer: LoadedTool = {
      name: 'shell_macos',
      description: 'x',
      runtime: 'server',
      inputSchema: { type: 'object' },
      guide: '',
    }

    const web = buildTurnTools([fakeServer], false)
    expect(web.map((t) => t.function.name)).not.toContain('shell_macos')

    const tauri = buildTurnTools([fakeServer], true)
    expect(tauri.map((t) => t.function.name)).toContain('shell_macos')
  })
})
