// toolContext 单测：ctx 白名单的守卫（cycle/depth/stale）+ 副作用落地。
// 用唯一名的 fake tool 注册进单例工厂（不与真实工具重名，无污染）。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { rootStore, sessionsAtom, resetRootStore } from '../state/rootStore'
import { getSessionStore, resetSessionStores } from '../state/sessionStore'
import { setRun } from '../state/sessionWriters'
import { getPlan, setPlan } from '../state/planWriters'
import { browserCardsAtom, toolActivityAtom } from '../state/transientAtoms'
import { toolRegistry } from '../tools/registry'
import type { Tool } from '../tools/types'
import { createCoreInstance, type CoreInstance } from './core/coreInstance'
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

function seedRunningCoreSession(core: CoreInstance, id = 's1', runId = 'r'): void {
  core.rootStore.setter(sessionsAtom, (prev) => ({
    ...prev,
    [id]: { id, title: 't', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 0 },
  }))
  setRun(id, { runId, status: 'running' }, core)
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

  it('被顶掉的旧 run 不能提交阶段结果；计划状态保持不变', () => {
    seedRunningSession('s1', 'new-run')
    setPlan('s1', {
      id: 'plan-1',
      title: '计划',
      objective: '完成实现',
      status: 'active',
      revision: 3,
      requiresApproval: false,
      createdAt: 1,
      updatedAt: 2,
      stages: [{
        id: 'build',
        title: '实现',
        objective: '写代码',
        deliverables: [],
        dependencies: [],
        status: 'in_progress',
        evidence: ['tests'],
      }],
    })
    const stale = ctxFor('submit_stage_result', 's1', 'old-run')

    expect(() => stale.submitStageResult?.({
      planId: 'plan-1',
      revision: 3,
      stageId: 'build',
      summary: '已实现',
      evidence: ['tests'],
    })).toThrow('stale')
    expect(getPlan('s1')).toMatchObject({ revision: 3, stages: [{ status: 'in_progress' }] })
  })
})

describe('ctx 计划实例归属', () => {
  it('custom core 创建和读取计划不落入 defaultCore', () => {
    const core = createCoreInstance()
    seedRunningCoreSession(core)
    const ctx = buildToolContext({
      sessionId: 's1', runId: 'r', signal: new AbortController().signal, callId: 'call1', toolName: 'create_plan', core,
    })

    expect(ctx.createPlan!({
      title: '自定义实例计划',
      objective: '验证计划归属',
      stages: [{ id: 'stage-1', title: '验证', objective: '写入 custom core' }],
    })).toMatchObject({ ok: true })
    expect(getPlan('s1', core)).toMatchObject({ title: '自定义实例计划' })
    expect(ctx.getPlan!()).toMatchObject({ title: '自定义实例计划' })
    expect(getPlan('s1')).toBeUndefined()
  })
})

describe('ctx.runShell 桥接', () => {
  it('live run：写 shell 进度；Vitest/浏览器无 Tauri 时返回可读错误 result', async () => {
    seedRunningSession('s1', 'r')
    const ctx = ctxFor('shell_exec', 's1', 'r')

    const result = await ctx.runShell({ platform: 'macos', command: 'pwd', cwd: '/tmp' })

    expect(getSessionStore('s1').store.getter(toolActivityAtom)).toEqual([
      { callId: 'call1', toolName: 'shell_exec', text: '执行 shell: pwd' },
    ])
    expect(result).toMatchObject({
      platform: 'macos',
      shell: 'unavailable',
      command: 'pwd',
      cwd: '/tmp',
      exitCode: 1,
      stdout: '',
      timedOut: false,
      truncated: false,
    })
    expect(result.stderr).toContain('Tauri desktop runtime')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('命令行 rm 明确标记为不可撤回', async () => {
    seedRunningSession('s1', 'r')
    const ctx = ctxFor('shell_macos', 's1', 'r')

    const result = await ctx.runShell({ platform: 'macos', command: 'rm note.txt', cwd: '/tmp' })

    expect(result.reversible).toBe(false)
  })

  it('stale / aborted runShell 直接抛 stale，不调用桥接副作用', async () => {
    seedRunningSession('s1', 'r')

    await expect(ctxFor('shell_exec', 's1', 'OLD').runShell({ platform: 'macos', command: 'pwd' })).rejects.toThrow(
      'stale',
    )

    const controller = new AbortController()
    controller.abort()
    const aborted = buildToolContext({
      sessionId: 's1',
      runId: 'r',
      signal: controller.signal,
      callId: 'call2',
      toolName: 'shell_exec',
    })

    await expect(aborted.runShell({ platform: 'macos', command: 'pwd' })).rejects.toThrow('stale')
    expect(getSessionStore('s1').store.getter(toolActivityAtom)).toEqual([])
  })
})

describe('ctx.runWorkspaceTask 桥接', () => {
  it('live run：写 task 进度；Vitest/浏览器无 Tauri 时返回可读错误 result', async () => {
    seedRunningSession('s1', 'r')
    const ctx = ctxFor('run_task', 's1', 'r')

    const result = await ctx.runWorkspaceTask!({ kind: 'test' })

    expect(getSessionStore('s1').store.getter(toolActivityAtom)).toEqual([
      { callId: 'call1', toolName: 'run_task', text: '运行任务: test' },
    ])
    expect(result).toMatchObject({
      ok: false,
      exitCode: 1,
      stdout: '',
      timedOut: false,
      truncated: false,
      command: [],
      kind: 'test',
    })
    expect(result.stderr).toContain('Tauri desktop runtime')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })
})
