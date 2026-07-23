// TK3 tool lazy 加载闸门 —— 单测先行（红→绿）。
// ---------------------------------------------------------------------------
// agentNew 无 timeline：只测纯逻辑（去重 + 懒加载 schema + 累计 loadedTools）。
//   · appendVisibleTool：按 name 去重加入，返回新数组；已含则原样返回。
//   · ensureToolLoaded：已含则原样返回；否则 loadTool → appendVisibleTool →
//     patchRun(id, { loadedTools }) 累计已载 → 返回新数组。未知 tool 原样返回。
// 依赖状态层：seed 会话 + setRun 建 run（patchRun 无既有 run 时 no-op）。

import { afterEach, describe, expect, it } from 'vitest'

import { rootStore, sessionsAtom, resetRootStore } from '../state/rootStore'
import { getSessionStore, resetSessionStores } from '../state/sessionStore'
import { runAtom } from '../state/sessionAtoms'
import { setRun } from '../state/sessionWriters'
import { toolRegistry } from '../tools/registry'
import type { LoadedTool } from '../tools/types'
import { createCoreInstance } from './core/coreInstance'
// 集成性质：本文件测的是「懒加载真实 save_file 工具」，故从 meta 包取标准工具装进独立 core（TS2）。
import { registerStandardTools } from '@web-agent/tools'
import { appendVisibleTool, ensureToolLoaded } from './toolLoading'

afterEach(() => {
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
  it('加载新 tool → 返回长度 1 且含 save_file，并累计到 run.loadedTools', () => {
    seedRunningSession('s1')

    const next = ensureToolLoaded('s1', [], 'save_file')

    expect(next).toHaveLength(1)
    expect(next.map((t) => t.name)).toContain('save_file')
    expect(getSessionStore('s1').store.getter(runAtom)?.loadedTools).toContain('save_file')
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
