// 无头消费者验证（core 抽离 Stage 3 的终极证明，PX2 注册面 + PX5 观察=订阅 atom）。
// ---------------------------------------------------------------------------
// 证明抽离的终极目的达成：【不碰 React，就能注册插件、驱动一次 run、只经事件流观察 core】。
//   本文件扮演一个未来的非 React 消费方（TUI / RPC / SDK）——它只 import core + 事件流 + 状态核心，
//   全程没有 import 任何 ui/ 下的东西、没有渲染任何 React（文末 `结构证明` 用例读自身源码把这条钉死）。
//
// fixture 全真、绝不 mock 掉 core 本身：
//   · 真 einfach store（getSessionStore，与投影器 / loop 同一实例）；
//   · 真 runToolLoop（经 runSession 入口）；
//   · 假 fetch（回一个非流式 assistant 回复）—— 只有「模型响应」这一处外部边界被替身。
//
// 注意（诚实报告已知缝）：本 Stage 上游【未】把 assemblePlugins 接进 modelRun —— modelRun 内部
//   装配的是它自己的内置插件（migration/loopGuard/finishReason/compaction），看不到本测试注册的插件。
//   所以本测试就是那个「未来的宿主 / loop」：它亲手 assemblePlugins → bindSubscriptions(store) →
//   subscribeAgentEvents → 驱动 run。其中：
//     · subscribe(itemsAtom) 经 bindSubscriptions 绑上真 store 后，被【真实 loop 的 itemsAtom 写入】
//       同步驱动 —— 这是插件「活着观察真 run」的强证明；
//     · transformContext hook 因 modelRun 尚未接线，由本宿主用真 CoreCtx 手动驱动一次，证明合成的
//       复合 hook 可读实时 core 状态、可变换请求投影（接进 loop 留待后续 Stage）。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { rootStore, sessionsAtom } from '../../state/rootStore'
import { getSessionStore } from '../../state/sessionStore'
import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import { createToolRegistry } from '../../tools/registry'
import type { Tool } from '../../tools/types'
import { runSession } from '../modelRun'
import { makeCoreCtx } from './coreCtx'
import { subscribeAgentEvents, type AgentEvent } from './events'
import type { RequestDraft } from './loopHooks'
import { assemblePlugins, type AgentPlugin } from './pluginApi'
import { createHistory } from '@einfach/core'
import { createSessionHistory } from '../../state/sessionHistory'

// 每个用例自 seed；共享 store 由测试 setup 在每个用例后复位（同 events.test）。

// 在 rootStore 登记会话（ghost guard 的权威事实；runToolLoop 也据此不 no-op）。
function seedSession(id: string): void {
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
}

// 假 fetch：回一个非流式 assistant 回复（postChatCompletion 走 res.json()）——最简单一轮、无 tool_calls。
function assistantReply(content: string): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
}

// 一个假工具（只为证明 registerTool 收集 + 无头宿主可接入隔离 ToolRegistry；不进真实 loop）。
function makeFakeTool(): Tool {
  return {
    name: 'headless_fake_tool',
    runtime: 'internal',
    skill: { description: '无头验证用的假工具', content: '假工具指南正文' },
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    execute: () => ({ ok: true, data: { echoed: true } }),
  }
}

describe('无头消费者（headless consumer）—— 消费方可替换的终极验证（Stage 3）', () => {
  it('注册插件 → 驱动真实 run → 只经事件流观察到符合真实时序的规范化流；插件 subscribe 同步观察到 run', async () => {
    seedSession('h1')
    const store = getSessionStore('h1').store

    // ── 1) 一个测试插件，同时行使三种注册能力（PX2 装配期注册面）─────────────────
    const observedItemCounts: number[] = [] // subscribe(itemsAtom) 每次看到的历史长度
    let transformContextSawItems = -1 // transformContext hook 从 ctx.store 读到的历史长度
    const fakeTool = makeFakeTool()
    const plugin: AgentPlugin = (api) => {
      // 观察型：订阅 itemsAtom（PX5 观察=订阅 atom，不另造事件总线）。
      api.subscribe(itemsAtom, (items) => observedItemCounts.push(items.length))
      // 变换型：transformContext hook —— 状态从 ctx.store 现取（不穿参），就地改请求投影 draft。
      api.hook('transformContext', (ctx, draft) => {
        transformContextSawItems = ctx.store.getter(itemsAtom).length
        draft.messages.push({ role: 'system', content: 'headless-marker' })
      })
      // 能力型：registerTool —— 消费方稍后决定落进哪个 ToolRegistry（本 API 不碰全局单例）。
      api.registerTool(fakeTool)
    }
    const hooks = assemblePlugins([plugin])

    // 装配产物立即可见：registerTool 收进 tools 清单，transformContext 合成为可调复合 hook。
    expect(hooks.tools).toContain(fakeTool)
    expect(hooks.transformContext).toBeTypeOf('function')

    // ── 2) 无头宿主把订阅意向绑到真 store（未来 loop 会做的事，本轮由消费方手动做）──────
    const disposeSubs = hooks.bindSubscriptions(store)

    // ── 3) 只经规范化事件流观察 core（不认识 React / 前端）──────────────────────────
    const events: AgentEvent[] = []
    const unsubscribe = subscribeAgentEvents('h1', (e) => events.push(e))

    // ── 4) 假 fetch 驱动一次真实 runSession（内部 append user → setRun → 真 runToolLoop）──
    await runSession('h1', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl: assistantReply('你好'),
    })

    // ── 5) 断言：事件流【符合真实时序】────────────────────────────────────────────
    const items = store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant'])
    const runId = store.getter(runAtom)?.runId
    if (typeof runId !== 'string') throw new Error('run 未产生 runId')

    // 真实时序（事件类型逐条比对）：
    //   message_appended(user)  ← runSession appendItem(user)
    //   run_start / run_status_changed(running)  ← runSession setRun(running)
    //   message_appended(tool) ← sessionStart timed skills 清单
    //   message_appended(assistant)  ← loop append assistant
    //   run_status_changed(done) / run_end(done)  ← loop patchRun(done)
    expect(events.map((e) => e.type)).toEqual([
      'message_appended',
      'run_start',
      'run_status_changed',
      'message_appended',
      'message_appended',
      'run_status_changed',
      'run_end',
    ])

    // 逐个 payload 精确断言。
    expect(events[0]).toEqual({ type: 'message_appended', item: items[0] }) // user 条目引用稳定
    expect(events[1]).toEqual({ type: 'run_start', runId })
    expect(events[2]).toEqual({ type: 'run_status_changed', status: 'running' })
    // assistant 增量：投影器发的是【append 时刻】的快照。真实发现——即便是非流式 JSON 回复，modelRun 也
    // 走「先 append pending:true（内容已完整）→ 再就地 finalize 成 pending:false」两步；后一步是等长替换，
    // 投影器按契约【不再发】message_appended。故事件里是 pending:true 版本，与最终 items[1]（pending:false）
    // 同一 id、同样 role/content，仅 pending 不同。
    const asst = events[4]
    if (asst.type !== 'message_appended') throw new Error('期望第 5 条是 assistant message_appended')
    expect(asst.item.id).toBe(items[2].id)
    expect(asst.item.item).toEqual({ role: 'assistant', content: '你好' })
    expect(events[5]).toEqual({ type: 'run_status_changed', status: 'done' })
    expect(events[6]).toEqual({ type: 'run_end', runId, status: 'done' })

    // 插件的 subscribe 被【真 loop 的 itemsAtom 每一次写入】同步驱动（裸 atom 订阅，比投影器更细）：
    //   append user → 1；sessionStart timed tool → 2；append pending assistant → 3；finalize assistant（就地等长替换）→ 仍 3。
    // 变异自检：若 subscribe 未被真 loop 驱动、或压缩等插件误写回 itemsAtom，这里会偏离 [1, 2, 3, 3]。
    expect(observedItemCounts).toEqual([1, 2, 3, 3])

    // ── 6) transformContext hook：无头宿主用真 CoreCtx 驱动它读实时 core 状态 + 变换请求投影 ──
    const ctx = makeCoreCtx({
      sessionId: 'h1',
      runId,
      signal: new AbortController().signal,
      store,
      root: rootStore, history: createSessionHistory(store),
      traceEvent: () => {},
    })
    const draft: RequestDraft = { messages: [] }
    await hooks.transformContext?.(ctx, draft)
    // hook 从 ctx.store 现取到真实的 3 条历史（user + sessionStart tool + assistant）。
    expect(transformContextSawItems).toBe(3)
    // hook 只改请求投影、绝不写回 itemsAtom（历史仍是 3 条）。
    expect(draft.messages).toEqual([{ role: 'system', content: 'headless-marker' }])
    expect(store.getter(itemsAtom)).toHaveLength(3)

    unsubscribe()
    disposeSubs()
  })

  it('registerTool：assemblePlugins 收集的工具可被无头宿主接入一个隔离 ToolRegistry（不碰全局单例）', () => {
    const fakeTool = makeFakeTool()
    const plugin: AgentPlugin = (api) => api.registerTool(fakeTool)
    const hooks = assemblePlugins([plugin])

    // 按注册序收进清单（无人注册时是 []，这里恰是那一个）。
    expect(hooks.tools).toEqual([fakeTool])

    // 无头宿主自建隔离 registry，把插件工具接进去（蓝图 §八·4 多实例化铺路；不 mutate 全局 toolRegistry）。
    const registry = createToolRegistry()
    for (const tool of hooks.tools) registry.register(tool)

    expect(registry.has('headless_fake_tool')).toBe(true)
    expect(registry.list().map((t) => t.name)).toContain('headless_fake_tool')
    const loaded = registry.loadSchema('headless_fake_tool')
    expect(loaded?.inputSchema).toEqual(fakeTool.inputSchema)
    expect(loaded?.guide).toBe('假工具指南正文')
  })

  it('unsubscribe 后再驱动一次真实 run，不再收到任何事件（消费方彻底断开）', async () => {
    seedSession('h2')

    const events: AgentEvent[] = []
    const unsubscribe = subscribeAgentEvents('h2', (e) => events.push(e))

    await runSession('h2', 'first', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl: assistantReply('一'),
    })
    expect(events.length).toBeGreaterThan(0)
    const seenBefore = events.length

    // 断开事件流。
    unsubscribe()

    // 再真跑一轮（同会话第二条消息）—— 事件流已断，events 不再增长。
    await runSession('h2', 'second', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl: assistantReply('二'),
    })

    expect(events.length).toBe(seenBefore)
    // 第二轮确实真的跑了（itemsAtom 长到 5：首轮 sessionStart tool + user/assistant ×2）—— 证明「不收事件」不是因为没跑。
    expect(getSessionStore('h2').store.getter(itemsAtom)).toHaveLength(5)
  })

  it('结构证明：本测试文件不 import 任何 ui/ 下的东西、不 import React（纯 core 消费方）', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    // 抓所有 `... from '<specifier>'` 的模块路径（含 import type）。
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])

    // 没有从任何 ui/ 目录 import。
    expect(specifiers.filter((s) => /\/ui\//.test(s) || /\/ui$/.test(s))).toEqual([])
    // 没有 React / react-dom / testing-library / renderWithStore（= 没渲染任何 React）。
    expect(specifiers.filter((s) => /^react(-dom)?(\/|$)/.test(s))).toEqual([])
    expect(specifiers.filter((s) => /@testing-library/.test(s))).toEqual([])
    expect(specifiers.filter((s) => /renderWithStore/.test(s))).toEqual([])
    // 正向确认：确实经 core 的规范化事件流观察（subscribeAgentEvents）。
    expect(source).toMatch(/subscribeAgentEvents/)
  })
})
