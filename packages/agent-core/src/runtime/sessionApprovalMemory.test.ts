// F7：「一律允许」的记忆资格判据。三个调用点（confirmTool / writer / reader）都问这里，
// 所以这一层的行为必须自己被钉住 —— 名字匹配一旦松掉，三条路一起松。

import { describe, expect, it } from 'vitest'
import { sessionsAtom } from '../state/rootAtoms'
import {
  addAlwaysAllowedTool,
  alwaysAllowedToolsAtom,
  isToolAlwaysAllowed,
} from '../state/transientAtoms'
import { createCoreInstance, type CoreInstance } from './core/coreInstance'
import { MCP_CONNECT_TOOL_NAME } from './dangerousTools'
import { canRememberToolApproval, NEVER_REMEMBERED_TOOLS } from './sessionApprovalMemory'

const SESSION = 's1'

/** 造一个登记好会话的隔离 core：不登记会话，写入器的 ghost guard 会先把写拦掉，测不到判据。 */
function seededCore(): CoreInstance {
  const core = createCoreInstance()
  core.rootStore.setter(sessionsAtom, {
    [SESSION]: {
      id: SESSION,
      title: 't',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
    },
  })
  return core
}

describe('canRememberToolApproval', () => {
  it('连接工具永远没有记忆资格：按名字记会把「同意连 A」放大成「同意连任意服务」', () => {
    expect(canRememberToolApproval(MCP_CONNECT_TOOL_NAME)).toBe(false)
    expect(NEVER_REMEMBERED_TOOLS.has(MCP_CONNECT_TOOL_NAME)).toBe(true)
  })

  it.each([
    'mcp__playwright__browser_navigate',
    'mcp__chrome-devtools__click',
    'mcp__',
  ])('既有的 mcp__ 前缀行为不回退：%s', (toolName) => {
    expect(canRememberToolApproval(toolName)).toBe(false)
  })

  it.each([
    'write_file',
    'apply_patch',
    'shell_macos',
    'delete_path',
    'read_file',
  ])('普通工具仍可被本会话记住：%s', (toolName) => {
    expect(canRememberToolApproval(toolName)).toBe(true)
  })

  it('只认完整名等值，不做前缀特判：同前缀的别的名字不受牵连', () => {
    expect(canRememberToolApproval(`${MCP_CONNECT_TOOL_NAME}_v2`)).toBe(true)
    expect(canRememberToolApproval('connect_mcp')).toBe(true)
    // 反向：不带 mcp__ 前缀的连接工具，也不能靠「前缀没命中」溜进记忆。
    expect(MCP_CONNECT_TOOL_NAME.startsWith('mcp__')).toBe(false)
  })
})

// 判据只有被【每一个】enforcement 点问到才算数。下面两组分别钉 writer 与 reader：
// writer 挡住「写进去」，reader 挡住「已经在里面的也不认」——后者才是历史数据/越权写入的兜底。
describe('addAlwaysAllowedTool（writer）拒写无记忆资格的工具', () => {
  it.each([MCP_CONNECT_TOOL_NAME, 'mcp__playwright__browser_navigate'])(
    '直接调用写入器也写不进去：%s',
    (toolName) => {
      const core = seededCore()

      addAlwaysAllowedTool(SESSION, toolName, core)

      expect(core.getSessionStore(SESSION).store.getter(alwaysAllowedToolsAtom)).toEqual([])
      expect(isToolAlwaysAllowed(SESSION, toolName, core)).toBe(false)
    },
  )

  it('普通危险工具不受影响：write_file 照旧写入并去重', () => {
    const core = seededCore()

    addAlwaysAllowedTool(SESSION, 'write_file', core)
    addAlwaysAllowedTool(SESSION, 'write_file', core)
    addAlwaysAllowedTool(SESSION, 'shell_macos', core)

    expect(core.getSessionStore(SESSION).store.getter(alwaysAllowedToolsAtom))
      .toEqual(['write_file', 'shell_macos'])
    expect(isToolAlwaysAllowed(SESSION, 'write_file', core)).toBe(true)
  })
})

describe('isToolAlwaysAllowed（reader）不认无记忆资格的工具', () => {
  it('atom 被直接污染（历史数据 / 越权写入）时仍判 false，同一份污染里的 write_file 照常生效', () => {
    const core = seededCore()
    const store = core.getSessionStore(SESSION).store

    store.setter(alwaysAllowedToolsAtom, [
      MCP_CONNECT_TOOL_NAME,
      'mcp__playwright__browser_navigate',
      'write_file',
    ])

    expect(isToolAlwaysAllowed(SESSION, MCP_CONNECT_TOOL_NAME, core)).toBe(false)
    expect(isToolAlwaysAllowed(SESSION, 'mcp__playwright__browser_navigate', core)).toBe(false)
    expect(isToolAlwaysAllowed(SESSION, 'write_file', core)).toBe(true)
  })
})
