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
import { loadTool, type LoadedTool } from '../tools/registry'
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
  const saveFile = loadTool('save_file') as LoadedTool

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
