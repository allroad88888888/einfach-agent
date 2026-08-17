// P-R3 命令 API 的单测（红→绿）。T3 从 commands.test.ts 拆出：危险工具确认的暂停恢复。
// ---------------------------------------------------------------------------
// 契约 U1/U2：commands 是 UI ↔ runtime 的唯一边界，且不收 store。
// 本测只断言「编排」：confirmTool 是否按约定回填 ToolItem、清 pendingToolConfirmation、
// 走 runToolLoop 续跑，以及「一律允许」集合的写入边界（MCP 工具/连接工具/不可撤回命令不落库）。
// 真实 model / abort / checkpoint 全部 mock 掉。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// —— mock runtime 依赖：只验证编排，不跑真实 model / abort / checkpoint。——
vi.mock('./modelRun', () => ({
  runSession: vi.fn(() => Promise.resolve()),
  resumeInterruptedSession: vi.fn(() => Promise.resolve()),
  resumePlanSession: vi.fn(() => Promise.resolve()),
  runToolLoop: vi.fn(() => Promise.resolve()),
}))
vi.mock('../state/checkpointWriters', () => ({
  jumpToCheckpoint: vi.fn(),
  rewindBeforeCheckpoint: vi.fn(),
  revertToPlanStageCheckpoint: vi.fn(),
  updateCheckpoint: vi.fn(),
}))
// D-4：持久化桥全 mock —— 只验证 commands 按约定调用了落盘钩子（不跑真实 IndexedDB）。
vi.mock('./persistenceBridge', () => ({
  persistSessions: vi.fn(),
  persistWorkspaces: vi.fn(),
  persistDeleteSession: vi.fn(),
  persistTruncate: vi.fn(),
  persistCheckpoint: vi.fn(),
}))

import { getSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { alwaysAllowedToolsAtom } from '../state/transientAtoms'
import type { ConversationItem, RunState } from '../state/core.type'
import { runToolLoop } from './modelRun'
import { configureCommands, newSession, confirmTool } from './commands'
import { MCP_CONNECT_TOOL_NAME } from './dangerousTools'
import { flush, spyOnDefaultAbort, type AbortSpies } from './commands.testHarness'

let beginRun: AbortSpies['beginRun']
let endRun: AbortSpies['endRun']

beforeEach(() => {
  ;({ beginRun, endRun } = spyOnDefaultAbort())
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('confirmTool（S4-B 危险工具确认恢复）', () => {
  // 造一条 assistant(tool_calls:[write_file{id}]) 条目（危险工具，暂停时 result 特意留空）。
  function dangerousAssistant(tcId: string): ConversationItem {
    return {
      id: 'a1',
      createdAt: 2,
      item: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: tcId, type: 'function', function: { name: 'write_file', arguments: '{}' } }],
      },
    }
  }

  // 种一个 waiting_confirmation 会话：user + assistant(write_file tc)、run waiting_confirmation +
  //   pendingToolConfirmation。返回 id（newSession 已设为 active）。
  function seedConfirming(tcId = 'w1'): string {
    configureCommands({ modelCredentials: { deepseek: 'k' } })
    const id = newSession()
    const store = getSessionStore(id).store
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: 'hi' } },
      dangerousAssistant(tcId),
    ])
    const run: RunState = {
      runId: 'R1',
      status: 'waiting_confirmation',
      pendingToolConfirmation: { callId: tcId, toolName: 'write_file', args: { path: 'a.txt', content: 'x' } },
    }
    store.setter(runAtom, run)
    vi.clearAllMocks() // 清掉 seed 期间 newSession 触发的 mock 调用记录
    return id
  }

  it('允许：落回 running + 清 pendingToolConfirmation + runToolLoop 带 resumeToolCall 续跑', async () => {
    const id = seedConfirming('w1')
    const store = getSessionStore(id).store

    confirmTool(true)

    const run = store.getter(runAtom)
    expect(run?.status).toBe('running')
    expect(run?.pendingToolConfirmation).toBeUndefined()

    await flush()
    expect(beginRun).toHaveBeenCalledWith(id)
    expect(runToolLoop).toHaveBeenCalledTimes(1)
    const call = vi.mocked(runToolLoop).mock.calls[0]
    expect(call[0]).toBe(id)
    expect(call[1]).toBe('R1')
    expect(call[2].resumeToolCall).toEqual({
      callId: 'w1',
      toolName: 'write_file',
      args: { path: 'a.txt', content: 'x' },
    })

    expect(endRun).toHaveBeenCalledWith(id, expect.anything())
  })

  it('允许 + always：把该工具记进本 session「一律允许」集合', () => {
    const id = seedConfirming('w1')
    confirmTool(true, true)
    expect(getSessionStore(id).store.getter(alwaysAllowedToolsAtom)).toContain('write_file')
  })

  it('MCP 工具即使直接调用 confirmTool(true,true) 也不写入 session「一律允许」集合', async () => {
    const id = seedConfirming('mcp-1')
    const store = getSessionStore(id).store
    const run = store.getter(runAtom)
    if (!run?.pendingToolConfirmation) throw new Error('缺少 pendingToolConfirmation')
    store.setter(runAtom, {
      ...run,
      pendingToolConfirmation: {
        ...run.pendingToolConfirmation,
        toolName: 'mcp__playwright__browser_navigate',
        args: { url: 'https://example.com' },
      },
    })

    confirmTool(true, true)
    await flush()

    expect(store.getter(alwaysAllowedToolsAtom)).not.toContain('mcp__playwright__browser_navigate')
    expect(runToolLoop).toHaveBeenCalledWith(
      id,
      'R1',
      expect.objectContaining({
        resumeToolCall: {
          callId: 'mcp-1',
          toolName: 'mcp__playwright__browser_navigate',
          args: { url: 'https://example.com' },
        },
      }),
    )
  })

  // F7：连接工具的风险由 serverId 决定（HTTP 只是一次网络请求，stdio 是在本机起子进程），
  // 而「一律允许」是按【工具名】记的。一旦它能被记住，用户对某一个服务点的那次同意，就变成
  // 了本会话内连接【任意】已配置服务的通行证。命令层必须在这里就不落库。
  it('连接 MCP 服务的工具即使 confirmTool(true,true) 也不写入 session「一律允许」集合', async () => {
    const id = seedConfirming('connect-1')
    const store = getSessionStore(id).store
    const run = store.getter(runAtom)
    if (!run?.pendingToolConfirmation) throw new Error('缺少 pendingToolConfirmation')
    store.setter(runAtom, {
      ...run,
      pendingToolConfirmation: {
        ...run.pendingToolConfirmation,
        toolName: MCP_CONNECT_TOOL_NAME,
        args: { serverId: 'local-fs' },
      },
    })

    confirmTool(true, true)
    await flush()

    expect(store.getter(alwaysAllowedToolsAtom)).not.toContain(MCP_CONNECT_TOOL_NAME)
    expect(store.getter(alwaysAllowedToolsAtom)).toEqual([])
    // 本次连接照常放行 —— 拦的是「记住」，不是「这一次」。
    expect(runToolLoop).toHaveBeenCalledWith(
      id,
      'R1',
      expect.objectContaining({
        resumeToolCall: {
          callId: 'connect-1',
          toolName: MCP_CONNECT_TOOL_NAME,
          args: { serverId: 'local-fs' },
        },
      }),
    )
  })

  it('不可撤回命令即使传入 always 也不加入「一律允许」集合', () => {
    const id = seedConfirming('w1')
    const store = getSessionStore(id).store
    const run = store.getter(runAtom)
    if (!run?.pendingToolConfirmation) throw new Error('缺少 pendingToolConfirmation')
    store.setter(runAtom, {
      ...run,
      pendingToolConfirmation: {
        ...run.pendingToolConfirmation,
        toolName: 'shell_macos',
        irreversible: true,
      },
    })

    confirmTool(true, true)

    expect(store.getter(alwaysAllowedToolsAtom)).not.toContain('shell_macos')
  })

  it('拒绝：回填该 tool_call 的 error result + 落回 running + runToolLoop 续跑（不带 resumeToolCall）', async () => {
    const id = seedConfirming('w1')
    const store = getSessionStore(id).store

    confirmTool(false)

    // 回填了 tool_call_id==='w1' 的 error ToolItem。
    const last = store.getter(itemsAtom).at(-1)!.item
    expect(last.role).toBe('tool')
    if (last.role !== 'tool') throw new Error('意外的条目形状')
    expect(last.tool_call_id).toBe('w1')
    expect(JSON.parse(last.content)).toEqual({ error: '用户拒绝执行该工具' })

    expect(store.getter(runAtom)?.status).toBe('running')
    await flush()
    expect(runToolLoop).toHaveBeenCalledTimes(1)
    // 拒绝不执行工具 → 不带 resumeToolCall。
    expect(vi.mocked(runToolLoop).mock.calls[0][2].resumeToolCall).toBeUndefined()
    expect(vi.mocked(runToolLoop).mock.calls[0][2]).not.toHaveProperty('resumeToolCall')
  })

  it('非 waiting_confirmation（running）→ no-op（不回填、不续跑）', () => {
    const id = seedConfirming('w1')
    const store = getSessionStore(id).store
    store.setter(runAtom, { runId: 'R1', status: 'running' })
    const before = store.getter(itemsAtom).length

    confirmTool(true)

    expect(store.getter(itemsAtom)).toHaveLength(before)
    expect(runToolLoop).not.toHaveBeenCalled()
  })

  it('缺 pendingToolConfirmation → 容错落回 running、不续跑', () => {
    const id = seedConfirming('w1')
    const store = getSessionStore(id).store
    store.setter(runAtom, { runId: 'R1', status: 'waiting_confirmation' })

    confirmTool(true)

    expect(store.getter(runAtom)?.status).toBe('running')
    expect(runToolLoop).not.toHaveBeenCalled()
  })

  it('无 active → no-op', () => {
    confirmTool(true)
    expect(runToolLoop).not.toHaveBeenCalled()
  })
})
