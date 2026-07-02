// toolContext 单测：ctx 白名单的守卫（cycle/depth/stale）+ 副作用落地。
// 用唯一名的 fake tool 注册进单例工厂（不与真实工具重名，无污染）。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { rootStore, sessionsAtom, resetRootStore } from '../state/rootStore'
import { getSessionStore, resetSessionStores } from '../state/sessionStore'
import { setRun } from '../state/sessionWriters'
import { browserCardsAtom, toolActivityAtom } from '../state/transientAtoms'
import { toolRegistry } from '../tools/registry'
import type { Tool } from '../tools/types'
import { buildToolContext } from './toolContext'

afterEach(() => {
  resetRootStore()
  resetSessionStores()
})

function seedRunningSession(id = 's1', runId = 'r'): void {
  rootStore.setter(sessionsAtom, (prev) => ({
    ...prev,
    [id]: { id, title: 't', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 0 },
  }))
  setRun(id, { runId, status: 'running' })
}

function fakeTool(name: string, execute: Tool['execute']): Tool {
  return { name, runtime: 'internal', skill: { description: name, content: name }, inputSchema: {}, execute }
}

function ctxFor(toolName: string, id = 's1', runId = 'r') {
  return buildToolContext({ sessionId: id, runId, signal: new AbortController().signal, callId: 'call1', toolName })
}

describe('ctx.callTool 守卫', () => {
  it('A→B→A 环：在 A 的第二次 execute 启动前就判出 cycle（不重复副作用，codex P2）', async () => {
    let aRuns = 0
    let bRuns = 0
    let innerResult: unknown
    toolRegistry.register(
      fakeTool('__cyc_a__', async (_args, ctx) => {
        aRuns += 1
        await ctx.callTool('__cyc_b__', {})
        return { ok: true }
      }),
    )
    toolRegistry.register(
      fakeTool('__cyc_b__', async (_args, ctx) => {
        bRuns += 1
        innerResult = await ctx.callTool('__cyc_a__', {}) // 这里应立刻判 cycle，A 不再跑
        return { ok: true }
      }),
    )
    seedRunningSession()

    await toolRegistry.run('__cyc_a__', {}, ctxFor('__cyc_a__'))

    expect(aRuns).toBe(1) // A 只跑一次（修复前会跑两次）
    expect(bRuns).toBe(1)
    expect(innerResult).toEqual({ ok: false, error: 'tool cycle: __cyc_a__' })
  })

  it('自调用 A→A 立刻 cycle', async () => {
    let runs = 0
    let inner: unknown
    toolRegistry.register(
      fakeTool('__self__', async (_args, ctx) => {
        runs += 1
        inner = await ctx.callTool('__self__', {})
        return { ok: true }
      }),
    )
    seedRunningSession()
    await toolRegistry.run('__self__', {}, ctxFor('__self__'))
    expect(runs).toBe(1)
    expect(inner).toEqual({ ok: false, error: 'tool cycle: __self__' })
  })

  it('callTool 正常调另一个工具 → 透传其结果；pause 不许冒泡', async () => {
    toolRegistry.register(fakeTool('__echo__', (args) => ({ ok: true, data: { echoed: args } })))
    toolRegistry.register(fakeTool('__pauser__', () => ({ pause: { q: 1 } })))
    seedRunningSession()
    const ctx = ctxFor('__caller__')
    expect(await ctx.callTool('__echo__', { x: 1 })).toEqual({ ok: true, data: { echoed: { x: 1 } } })
    expect(await ctx.callTool('__pauser__', {})).toEqual({ ok: false, error: 'cannot pause inside callTool' })
  })
})

describe('ctx 副作用 + stale 守卫', () => {
  it('progress 写 toolActivityAtom；renderCard 写卡片；stale（非当前 run）→ 拒绝', () => {
    seedRunningSession('s1', 'r')
    const live = ctxFor('skill_search', 's1', 'r')
    live.progress('搜索中')
    expect(getSessionStore('s1').store.getter(toolActivityAtom)).toEqual([
      { callId: 'call1', toolName: 'skill_search', text: '搜索中' },
    ])
    const r = live.renderCard({ title: 'T', body: 'B' })
    expect('cardId' in r).toBe(true)
    expect(getSessionStore('s1').store.getter(browserCardsAtom)).toHaveLength(1)

    // 被顶掉的旧 run（runId 不匹配）→ progress no-op、renderCard 回 stale。
    const stale = ctxFor('skill_search', 's1', 'OLD')
    stale.progress('迟到')
    expect(getSessionStore('s1').store.getter(toolActivityAtom)).toHaveLength(1) // 未新增
    expect(stale.renderCard({ title: 'X' })).toEqual({ error: 'stale' })
  })

  it('signal 已断 → progress no-op、saveArtifact 回 stale', () => {
    seedRunningSession('s1', 'r')
    const controller = new AbortController()
    controller.abort()
    const ctx = buildToolContext({ sessionId: 's1', runId: 'r', signal: controller.signal, callId: 'c', toolName: 'save_file' })
    ctx.progress('x')
    expect(getSessionStore('s1').store.getter(toolActivityAtom)).toEqual([])
    expect(ctx.saveArtifact({ filename: 'a.txt', content: 'x' })).toEqual({ error: 'stale' })
  })
})
