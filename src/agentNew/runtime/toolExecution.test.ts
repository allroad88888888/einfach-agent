// TK6 tool 执行分发单测（红→绿，单测先行）。
// ---------------------------------------------------------------------------
// runRuntimeTool 按 toolName 分发到 skill_search / skill_read / save_file /
// browser_action（不含 ask_user_question —— 由 tool 循环内联处理）。契约：
//   · 副作用只落到 transientAtoms（addPendingArtifact / addBrowserCard），
//     经 ghost guard（会话未登记 → no-op）。
//   · browser_action stale guard：signal.aborted 或 会话未登记 → {error:'stale'} 且不写。
//   · TK6：任何分支内部异常 catch 成 { error } JSON 返回，绝不抛（AbortError 透传）。
// 只依赖状态层 + skills registry；不 import UI。

import { afterEach, describe, expect, it } from 'vitest'

import { rootStore, sessionsAtom, resetRootStore } from '../state/rootStore'
import { getSessionStore, resetSessionStores } from '../state/sessionStore'
import { pendingArtifactsAtom, browserCardsAtom } from '../state/transientAtoms'
import { runRuntimeTool } from './toolExecution'

afterEach(() => {
  resetRootStore()
  resetSessionStores()
})

// 在 rootStore 登记一个会话（ghost guard 的权威事实；否则写入被拦）。
function seedSession(id = 's1'): void {
  rootStore.setter(sessionsAtom, (prev) => ({
    ...prev,
    [id]: { id, title: 't', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 0 },
  }))
}

// 未 abort 的 ctx。
function makeCtx(signal: AbortSignal = new AbortController().signal): { runId: string; signal: AbortSignal } {
  return { runId: 'r1', signal }
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}

describe('runRuntimeTool · skill_search', () => {
  it('返回 { query, results }，results 为命中的 skill 列表', async () => {
    const raw = await runRuntimeTool('s1', 'skill_search', { query: 'tool' }, makeCtx())
    const parsed = JSON.parse(raw)
    expect(parsed.query).toBe('tool')
    expect(Array.isArray(parsed.results)).toBe(true)
    expect(parsed.results.length).toBeGreaterThan(0)
    expect(parsed.results.some((s: { name: string }) => s.name === 'tool-loading')).toBe(true)
  })

  it('query 缺省 → String(undefined ?? "") = ""，不抛', async () => {
    const raw = await runRuntimeTool('s1', 'skill_search', {}, makeCtx())
    const parsed = JSON.parse(raw)
    expect(parsed.query).toBe('')
    expect(Array.isArray(parsed.results)).toBe(true)
  })
})

describe('runRuntimeTool · skill_read', () => {
  it('命中 → { name, skill }', async () => {
    const raw = await runRuntimeTool('s1', 'skill_read', { name: 'web-chat-agent' }, makeCtx())
    const parsed = JSON.parse(raw)
    expect(parsed.name).toBe('web-chat-agent')
    expect(parsed.skill).toBeTruthy()
    expect(parsed.skill.content).toBeTruthy()
    expect(parsed.error).toBeUndefined()
  })

  it('未命中 → { error }', async () => {
    const raw = await runRuntimeTool('s1', 'skill_read', { name: '不存在的skill' }, makeCtx())
    const parsed = JSON.parse(raw)
    expect(parsed.error).toBeTruthy()
    expect(parsed.skill).toBeUndefined()
  })
})

describe('runRuntimeTool · save_file', () => {
  it('成功：暂存到 pendingArtifactsAtom，返回 { accepted, artifactId, bytes }', async () => {
    seedSession('s1')
    const raw = await runRuntimeTool('s1', 'save_file', { filename: 'out.txt', content: 'hello' }, makeCtx())
    const parsed = JSON.parse(raw)
    expect(parsed.accepted).toBe(true)
    expect(parsed.bytes).toBe(5)
    expect(typeof parsed.artifactId).toBe('string')

    const staged = getSessionStore('s1').store.getter(pendingArtifactsAtom)
    expect(staged).toHaveLength(1)
    expect(staged[0]).toMatchObject({ id: parsed.artifactId, filename: 'out.txt', content: 'hello' })
  })

  it('空 content（合法）：bytes=0，仍暂存', async () => {
    seedSession('s1')
    const raw = await runRuntimeTool('s1', 'save_file', { filename: 'empty.txt', content: '' }, makeCtx())
    const parsed = JSON.parse(raw)
    expect(parsed.accepted).toBe(true)
    expect(parsed.bytes).toBe(0)
    expect(getSessionStore('s1').store.getter(pendingArtifactsAtom)).toHaveLength(1)
  })

  it('空 filename → { error }，不暂存', async () => {
    seedSession('s1')
    const raw = await runRuntimeTool('s1', 'save_file', { filename: '', content: 'x' }, makeCtx())
    const parsed = JSON.parse(raw)
    expect(parsed.error).toBeTruthy()
    expect(parsed.accepted).toBeUndefined()
    expect(getSessionStore('s1').store.getter(pendingArtifactsAtom)).toEqual([])
  })

  it('content 非 string → { error }', async () => {
    seedSession('s1')
    const raw = await runRuntimeTool('s1', 'save_file', { filename: 'a.txt', content: 123 }, makeCtx())
    const parsed = JSON.parse(raw)
    expect(parsed.error).toBeTruthy()
    expect(getSessionStore('s1').store.getter(pendingArtifactsAtom)).toEqual([])
  })

  it('会话未登记 → { error: "stale" }，不暂存', async () => {
    // 不 seed s1：rootStore.sessionsAtom 里没有它 → stale guard 先挡。
    const raw = await runRuntimeTool('s1', 'save_file', { filename: 'out.txt', content: 'hello' }, makeCtx())
    const parsed = JSON.parse(raw)
    expect(parsed.error).toBe('stale')
    expect(parsed.accepted).toBeUndefined()
    expect(getSessionStore('s1').store.getter(pendingArtifactsAtom)).toEqual([])
  })

  it('signal.aborted → { error: "stale" }，不暂存', async () => {
    seedSession('s1')
    const raw = await runRuntimeTool(
      's1',
      'save_file',
      { filename: 'out.txt', content: 'hello' },
      makeCtx(abortedSignal()),
    )
    const parsed = JSON.parse(raw)
    expect(parsed.error).toBe('stale')
    expect(parsed.accepted).toBeUndefined()
    expect(getSessionStore('s1').store.getter(pendingArtifactsAtom)).toEqual([])
  })
})

describe('runRuntimeTool · browser_action', () => {
  it('成功：render_card → 写 browserCardsAtom，返回 { ok, cardId, note }', async () => {
    seedSession('s1')
    const raw = await runRuntimeTool(
      's1',
      'browser_action',
      { action: 'render_card', payload: { title: '标题', body: '正文' } },
      makeCtx(),
    )
    const parsed = JSON.parse(raw)
    expect(parsed.ok).toBe(true)
    expect(typeof parsed.cardId).toBe('string')
    expect(typeof parsed.note).toBe('string')

    const cards = getSessionStore('s1').store.getter(browserCardsAtom)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ id: parsed.cardId, title: '标题', body: '正文' })
    expect(typeof cards[0].createdAt).toBe('number')
  })

  it('action 非 render_card → { error }，不写', async () => {
    seedSession('s1')
    const raw = await runRuntimeTool('s1', 'browser_action', { action: 'click', payload: { title: 'x' } }, makeCtx())
    const parsed = JSON.parse(raw)
    expect(parsed.error).toBeTruthy()
    expect(getSessionStore('s1').store.getter(browserCardsAtom)).toEqual([])
  })

  it('payload title 缺失 → { error }，不写', async () => {
    seedSession('s1')
    const raw = await runRuntimeTool('s1', 'browser_action', { action: 'render_card', payload: { body: 'x' } }, makeCtx())
    const parsed = JSON.parse(raw)
    expect(parsed.error).toBeTruthy()
    expect(getSessionStore('s1').store.getter(browserCardsAtom)).toEqual([])
  })

  it('会话未登记 → { error: "stale" }，不写', async () => {
    // 不 seed s1：rootStore.sessionsAtom 里没有它。
    const raw = await runRuntimeTool(
      's1',
      'browser_action',
      { action: 'render_card', payload: { title: '标题' } },
      makeCtx(),
    )
    const parsed = JSON.parse(raw)
    expect(parsed.error).toBe('stale')
    expect(getSessionStore('s1').store.getter(browserCardsAtom)).toEqual([])
  })

  it('signal.aborted → { error: "stale" }，不写', async () => {
    seedSession('s1')
    const raw = await runRuntimeTool(
      's1',
      'browser_action',
      { action: 'render_card', payload: { title: '标题' } },
      makeCtx(abortedSignal()),
    )
    const parsed = JSON.parse(raw)
    expect(parsed.error).toBe('stale')
    expect(getSessionStore('s1').store.getter(browserCardsAtom)).toEqual([])
  })
})

describe('runRuntimeTool · 未知工具 & TK6 降级', () => {
  it('未知 toolName → { error: "unknown tool: <name>" }', async () => {
    const raw = await runRuntimeTool('s1', 'no_such_tool', {}, makeCtx())
    const parsed = JSON.parse(raw)
    expect(parsed.error).toBe('unknown tool: no_such_tool')
  })

  it('TK6：分支内部异常被 catch 成 { error }，不抛', async () => {
    const boom = {
      toString() {
        throw new Error('boom')
      },
    }
    const raw = await runRuntimeTool('s1', 'skill_search', { query: boom }, makeCtx())
    const parsed = JSON.parse(raw)
    expect(parsed.error).toBe('boom')
  })

  it('TK6：AbortError 透传 rethrow（不吞）', async () => {
    const aborty = {
      toString() {
        const e = new Error('aborted')
        e.name = 'AbortError'
        throw e
      },
    }
    await expect(runRuntimeTool('s1', 'skill_search', { query: aborty }, makeCtx())).rejects.toThrow('aborted')
  })
})
