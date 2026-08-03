// TK3 tool lazy 加载闸门 —— 单测先行（红→绿）。
// ---------------------------------------------------------------------------
// agentNew 无 timeline：只测纯逻辑（去重 + 懒加载 schema + 累计 loadedTools）。
//   · appendVisibleTool：按 name 去重加入，返回新数组；已含则原样返回。
//   · ensureToolLoaded：已含则原样返回；否则 loadTool → appendVisibleTool →
//     patchRun(id, { loadedTools }) 累计已载 → 返回新数组。未知 tool 原样返回。
// 依赖状态层：seed 会话 + setRun 建 run（patchRun 无既有 run 时 no-op）。

import { afterEach, describe, expect, it, vi } from 'vitest'

import { rootStore, sessionsAtom, resetRootStore } from '../state/rootStore'
import { getSessionStore, resetSessionStores } from '../state/sessionStore'
import { runAtom } from '../state/sessionAtoms'
import { setRun } from '../state/sessionWriters'
import type { SessionMeta } from '../state/core.type'
import { toolRegistry } from '../tools/registry'
import type { LoadedTool, Tool } from '../tools/types'
import { createCoreInstance, type CoreInstance } from './core/coreInstance'
import { configurePersistence, resetPersistence } from './persistenceBridge'
// 集成性质：本文件测的是「懒加载真实 save_file 工具」，故从 meta 包取标准工具装进独立 core（TS2）。
import { registerStandardTools } from '@web-agent/tools'
import { appendVisibleTool, ensureToolLoaded, refreshVisibleTools } from './toolLoading'

afterEach(() => {
  resetPersistence()
  resetRootStore()
  resetSessionStores()
})

// 在 rootStore 登记会话（ghost guard 的权威事实），并建一个 running run。
function seedRunningSession(id = 's1'): void {
  rootStore.setter(sessionsAtom, (prev) => ({
    ...prev,
    [id]: {
      id,
      title: 't',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
    },
  }))
  setRun(id, { runId: 'r', status: 'running' })
}

function seedIndependentRunningSession(core: CoreInstance, id = 's1'): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 't',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
    },
  })
  core.getSessionStore(id).store.setter(runAtom, { runId: 'r', status: 'running' })
}

function makeVersionedTestTool(name: string, revision: string): Tool {
  return {
    name,
    runtime: 'internal',
    skill: {
      description: `${name} ${revision}`,
      content: `${name} guide ${revision}`,
    },
    inputSchema: {
      type: 'object',
      properties: {
        revision: { type: 'string', const: revision },
      },
    },
    execute: () => ({ ok: true }),
  }
}

describe('appendVisibleTool', () => {
  const saveFile = toolRegistry.loadSchema('save_file') as LoadedTool

  it('加入新 tool → 返回含它的新数组', () => {
    const next = appendVisibleTool([], saveFile)
    expect(next).toHaveLength(1)
    expect(next[0].name).toBe('save_file')
  })

  it('按 name 去重 → 已含则原样返回（同引用）', () => {
    const before = [saveFile]
    const after = appendVisibleTool(before, saveFile)
    expect(after).toBe(before)
    expect(after).toHaveLength(1)
  })
})

describe('ensureToolLoaded', () => {
  it('加载新 tool → 同步累计到 run 与会话级 loadedTools', () => {
    seedRunningSession('s1')

    const next = ensureToolLoaded('s1', [], 'save_file')

    expect(next).toHaveLength(1)
    expect(next.map((t) => t.name)).toContain('save_file')
    expect(getSessionStore('s1').store.getter(runAtom)?.loadedTools).toContain('save_file')
    expect(rootStore.getter(sessionsAtom).s1?.loadedTools).toEqual(['save_file'])
  })

  it('defaultCore 加载成功后立即把会话级 LRU 交给 sessions persistence', () => {
    const saveSessions = vi.fn(async (_sessions: SessionMeta[]) => {})
    configurePersistence({
      sessions: {
        saveSessions,
        async loadSessions() {
          return []
        },
        async saveWorkspaces() {},
        async loadWorkspaces() {
          return []
        },
      },
    })
    seedRunningSession('s1')

    ensureToolLoaded('s1', [], 'save_file')

    expect(saveSessions).toHaveBeenCalledTimes(1)
    expect(saveSessions.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        id: 's1',
        loadedTools: ['save_file'],
      }),
    ])
  })

  it('对同一 tool 再 ensure → 幂等（长度不变、原样返回）', () => {
    seedRunningSession('s1')

    const first = ensureToolLoaded('s1', [], 'save_file')
    const second = ensureToolLoaded('s1', first, 'save_file')

    expect(second).toBe(first)
    expect(second).toHaveLength(1)
  })

  it('未知 tool（loadTool 返回 undefined）→ 列表不变、run.loadedTools 不写', () => {
    seedRunningSession('s1')

    const next = ensureToolLoaded('s1', [], 'nope_unknown')

    expect(next).toEqual([])
    expect(getSessionStore('s1').store.getter(runAtom)?.loadedTools).toBeUndefined()
  })

  it('macOS/Linux/PowerShell shell、文件与 skill 共用同一会话级持久化路径', () => {
    seedRunningSession('all-platforms')
    const toolNames = [
      'shell_macos',
      'shell_linux',
      'shell_powershell',
      'read_file',
      'skill_search',
    ]
    let visible: LoadedTool[] = []

    for (const toolName of toolNames) {
      visible = ensureToolLoaded('all-platforms', visible, toolName)
    }

    expect(visible.map((tool) => tool.name)).toEqual(toolNames)
    expect(getSessionStore('all-platforms').store.getter(runAtom)?.loadedTools)
      .toEqual(toolNames)
    expect(rootStore.getter(sessionsAtom)['all-platforms']?.loadedTools)
      .toEqual(toolNames)
  })
})

// 【实例化 · 第 3 期穿线】ensureToolLoaded 补了尾参 core（默认 defaultCore）—— 传入 createCoreInstance()
// 造的独立 core 时，schema 应只从该 core 自己的工具注册表（tools）懒加载、累计的 loadedTools 只回落
// 该 core 自己的 run（经 core 尾参传给 patchRun），与 defaultCore（模块级 rootStore/getSessionStore/
// toolRegistry 背后那份）互不污染。这是第 3 期「两个隔离实例互不串台」证明的一部分。
describe('ensureToolLoaded —— core 参数隔离（第 3 期）', () => {
  it('传入独立 core：loadedTools 写回该 core 自己的 run；defaultCore 一侧（模块级 rootStore/run）不受影响', () => {
    const core = createCoreInstance({ registerTools: registerStandardTools })
    const id = 's1'
    // 只在【独立 core】登记会话 + 建 running run —— defaultCore（= 模块级 rootStore）里完全没有它。
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: 't',
        settings: { vendor: 'deepseek', model: 'x' },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    core.getSessionStore(id).store.setter(runAtom, { runId: 'r', status: 'running' })

    const next = ensureToolLoaded(id, [], 'save_file', core)

    expect(next.map((t) => t.name)).toContain('save_file')
    // 写回确实落进了独立 core 自己的 run（core.tools.loadSchema + patchRun(..., core) 都吃到了传入 core）。
    expect(core.getSessionStore(id).store.getter(runAtom)?.loadedTools).toContain('save_file')
    expect(core.rootStore.getter(sessionsAtom)[id]?.loadedTools).toEqual(['save_file'])

    // defaultCore 一侧：该会话从未在 defaultCore.rootStore（= 顶层 rootStore）登记过；
    // 模块级 getSessionStore(id) 取到的是 defaultCore 私有 Map 里的 store —— run 应仍是 undefined。
    expect(rootStore.getter(sessionsAtom)[id]).toBeUndefined()
    expect(getSessionStore(id).store.getter(runAtom)).toBeUndefined()
  })

  it('独立 core 未登记会话/无 run → patchRun 经该 core 的 ghost guard 仍 no-op（不是「传了 core 就跳过 guard」）', () => {
    const core = createCoreInstance({ registerTools: registerStandardTools })
    // 故意不在 core.rootStore 登记 —— 即便传入了一个「有效」的独立 core，patchRun 仍应 no-op。
    const next = ensureToolLoaded('ghost', [], 'save_file', core)

    // schema 懒加载本身不依赖会话登记，仍正常返回（只有 loadedTools 回写受 ghost guard 约束）。
    expect(next.map((t) => t.name)).toContain('save_file')
    expect(core.getSessionStore('ghost').store.getter(runAtom)).toBeUndefined()
  })
})

describe('dynamic tool snapshots and visible-tool LRU', () => {
  it('refreshVisibleTools replaces a same-name re-registration and drops it after unregister', () => {
    const core = createCoreInstance()
    const id = 'refresh'
    seedIndependentRunningSession(core, id)
    const firstRegistration = makeVersionedTestTool('remote_search', 'v1')
    core.tools.register(firstRegistration)

    const before = ensureToolLoaded(id, [], firstRegistration.name, core)
    const staleSnapshot = before[0]
    expect(staleSnapshot).toMatchObject({
      description: 'remote_search v1',
      guide: 'remote_search guide v1',
      registrationVersion: 1,
    })

    const replacement = makeVersionedTestTool('remote_search', 'v2')
    core.tools.register(replacement)
    const refreshed = refreshVisibleTools(id, before, core)

    expect(refreshed).not.toBe(before)
    expect(refreshed).toHaveLength(1)
    expect(refreshed[0]).not.toBe(staleSnapshot)
    expect(refreshed[0]).toMatchObject({
      description: 'remote_search v2',
      guide: 'remote_search guide v2',
      registrationVersion: 2,
      inputSchema: {
        properties: {
          revision: { const: 'v2' },
        },
      },
    })

    expect(core.tools.unregister(replacement.name, replacement)).toBe(true)
    const removed = refreshVisibleTools(id, refreshed, core)

    expect(removed).toEqual([])
    expect(core.getSessionStore(id).store.getter(runAtom)?.loadedTools).toEqual([])
    // registry 的瞬时下线只影响当前 run；会话级恢复意图必须保留，供 MCP 重连后命中。
    expect(core.rootStore.getter(sessionsAtom)[id]?.loadedTools).toEqual(['remote_search'])
  })

  it('a temporarily unavailable dynamic tool does not disappear when another schema loads', () => {
    const core = createCoreInstance()
    const id = 'restart-before-mcp-reconnect'
    seedIndependentRunningSession(core, id)
    core.rootStore.setter(sessionsAtom, (sessions) => ({
      ...sessions,
      [id]: {
        ...sessions[id],
        loadedTools: ['remote_search', 'local_tool'],
      },
    }))
    core.tools.register(makeVersionedTestTool('local_tool', 'v1'))

    let visible = ensureToolLoaded(id, [], 'remote_search', core, 2)
    visible = ensureToolLoaded(id, visible, 'local_tool', core, 2)

    expect(visible.map((tool) => tool.name)).toEqual(['local_tool'])
    expect(core.getSessionStore(id).store.getter(runAtom)?.loadedTools).toEqual(['local_tool'])
    expect(core.rootStore.getter(sessionsAtom)[id]?.loadedTools).toEqual([
      'remote_search',
      'local_tool',
    ])

    core.tools.register(makeVersionedTestTool('remote_search', 'v2'))
    visible = ensureToolLoaded(id, visible, 'remote_search', core, 2)

    expect(visible.map((tool) => tool.name)).toEqual(['local_tool', 'remote_search'])
    expect(core.rootStore.getter(sessionsAtom)[id]?.loadedTools).toEqual([
      'local_tool',
      'remote_search',
    ])
  })

  it('re-requesting a loaded tool promotes it to the LRU tail and evicts the oldest over budget', () => {
    const core = createCoreInstance()
    const id = 'lru'
    seedIndependentRunningSession(core, id)
    for (const name of ['alpha', 'beta', 'gamma']) {
      core.tools.register(makeVersionedTestTool(name, 'v1'))
    }

    let visible: LoadedTool[] = []
    for (const name of ['alpha', 'beta', 'gamma']) {
      visible = ensureToolLoaded(id, visible, name, core)
    }
    const betaSnapshot = visible[1]

    const promoted = ensureToolLoaded(id, visible, 'beta', core, 2)

    expect(promoted.map((tool) => tool.name)).toEqual(['gamma', 'beta'])
    expect(promoted[1]).toBe(betaSnapshot)
    expect(core.getSessionStore(id).store.getter(runAtom)?.loadedTools).toEqual([
      'gamma',
      'beta',
    ])
    expect(core.rootStore.getter(sessionsAtom)[id]?.loadedTools).toEqual([
      'gamma',
      'beta',
    ])
  })

  it('keeps the array reference when the same registration is already at the LRU tail', () => {
    const core = createCoreInstance()
    const id = 'stable'
    seedIndependentRunningSession(core, id)
    core.tools.register(makeVersionedTestTool('alpha', 'v1'))
    core.tools.register(makeVersionedTestTool('beta', 'v1'))

    const first = ensureToolLoaded(id, [], 'alpha', core, 2)
    const atTail = ensureToolLoaded(id, first, 'beta', core, 2)
    const stable = ensureToolLoaded(id, atTail, 'beta', core, 2)

    expect(stable).toBe(atTail)
    expect(stable[1]).toBe(atTail[1])
    expect(stable.map((tool) => tool.name)).toEqual(['alpha', 'beta'])
  })
})
