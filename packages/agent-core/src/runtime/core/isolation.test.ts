// 「实例化」第 3 期收口证明 —— 双实例端到端隔离（真 runToolLoop / 真命令，假 fetch 唯一替身）。
// ---------------------------------------------------------------------------
// 这是整个「实例化」的收口：证明【两个 core 能同时存在、互不串台】=「能嵌两次」。
//
// 与 createCore.test.ts 的分工：那份【mock 掉 modelRun】，只验证命令把哪套 core 派给了
//   runSession/runToolLoop（编排层隔离）。本份【不 mock 任何 runtime】——store / 主循环 / 命令
//   全用真的，唯一替身是 core.config.fetchImpl 注入的假 fetch（喂固定模型响应）。于是断言覆盖的
//   是「主循环状态流」这一层：一轮真实对话从 sendMessage 起、经真 runToolLoop 多轮编排、writers 落回
//   itemsAtom/runAtom/checkpointsAtom 的全过程，是否严格落在各自实例的 store 上、绝不外溢。
//
// 对撞手法（捕获串台回归的关键）：★ 两套实例【故意登记同一个 session id "s"】★。若它们哪天漏穿一处
//   core、共享了任何 store（rootStore / per-session store / abort），同 id 会立刻串台 —— 本测即红：
//   · 共享 rootStore → A 读 's' 拿到 B 后写的 meta（title 对不上）。
//   · 共享 per-session store → A 的 's' 里混进 B 的对话条目（items 长度/内容对不上）。
//   · 共享 abort 注册表 → 并发时 B.beginRun('s') 掐掉 A 的 run（A 落 stopped 而非 done）。
//   全程还钉死 defaultCore 零污染（隔离实例绝不回写全局默认那一套）。
//
// 已知残留缺口（本测【不】触发，故不影响绿）：子 agent 委派（subagents/runtime.ts 内部走
//   defaultCore，Phase 2.5 补）、planning 的 getPlan/setPlan（approvePlan 仍绑
//   defaultCore）、以及 core/events.ts 的 subscribeAgentEvents 尚未 core-aware（走模块级 getSessionStore）。
//   工具懒加载 ensureToolLoaded 与 isToolAlwaysAllowed 的主循环调用点【已穿 core】（本轮收尾），不再是缺口。
//   主循环的「纯对话」路径（本测走的这条）已 100% 穿好，隔离成立。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCore } from './createCore'
import { defaultCore, type CoreInstance } from './coreInstance'
import type { Tool } from '../../tools/types'
import { sessionsAtom, activeSessionIdAtom } from '../../state/rootStore'
import { itemsAtom, runAtom, checkpointsAtom } from '../../state/sessionAtoms'
import { getPlan, setPlan } from '../../state/planWriters'
import { configurePersistence, resetPersistence } from '../persistenceBridge'
import { resetObservability } from '../../observability/trace'
import type { ConversationItem, SessionMeta } from '../../state/core.type'
import type { PlanSnapshot } from '../../planning/types'
import type { SessionsPersistence } from '../../state/persistence/contract'
import type { HistoryDriver } from '../../state/persistence/historyDriver'

// ── 假 fetch ───────────────────────────────────────────────────────────────
// 非流式 JSON 响应：postChatCompletionStream 检测到 content-type 非 text/event-stream 即回退
//   res.json()，故请求体里的 stream:true 不影响 —— 照样拿到这条完整响应（与 modelRun.test.ts 同款）。
function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// 造一个「永远回同一句 assistant 文本」的假 fetch，并记录每次收到的 Authorization ——
//   用来证明 apiKey 也按实例隔离：A 一路只带自己的 KA、B 只带 KB，绝不串到对方或 defaultCore。
function replyFetch(content: string): { fetchImpl: typeof fetch; auths: string[] } {
  const auths: string[] = []
  const fetchImpl: typeof fetch = async (_url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (typeof headers.Authorization === 'string') auths.push(headers.Authorization)
    return jsonResponse(content)
  }
  return { fetchImpl, auths }
}

// 最小 fake Tool：验证注册表隔离机制，不牵涉具体标准工具（TS2）。
function makeTool(name: string): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: `${name} 摘要`, content: `# ${name}` },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  }
}

function persistenceSpies() {
  const saveCheckpoint = vi.fn(async () => {})
  const saveSessions = vi.fn(async (_sessions: SessionMeta[]) => {})
  return {
    history: {
      listCheckpoints: vi.fn(async () => []),
      loadCheckpoint: vi.fn(async () => undefined),
      saveCheckpoint,
      truncateAfter: vi.fn(async () => {}),
      deleteSession: vi.fn(async () => {}),
    } satisfies HistoryDriver,
    sessions: {
      saveSessions,
      loadSessions: vi.fn(async () => []),
      saveWorkspaces: vi.fn(async () => {}),
      loadWorkspaces: vi.fn(async () => []),
    } satisfies SessionsPersistence,
    saveCheckpoint,
    saveSessions,
  }
}

// 在给定 core 里登记一个会话（ghost guard 的权威事实）并设为 active。★ 调用方故意让两套实例都用
//   同一个 id，才能真正考验隔离（共享 store 时同 id 立刻对撞）。★ title 各异，供「读到的是自己那份
//   meta」判定。
function seedSession(core: CoreInstance, id: string, title: string): void {
  const meta: SessionMeta = {
    id,
    title,
    settings: { vendor: 'deepseek', model: 'm' },
    createdAt: 0,
    updatedAt: 0,
  }
  core.rootStore.setter(sessionsAtom, (prev) => ({ ...prev, [id]: meta }))
  core.rootStore.setter(activeSessionIdAtom, id)
}

// 轮询直到条件成立（真 fetch 是异步的，run 靠微任务推进）。
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function roles(items: ConversationItem[]): string[] {
  return items.map((it) => it.item.role)
}

// 取一条 item 的文本内容（user/assistant/tool/system 都有 content；assistant 可能是 null）。
function textOf(ci: ConversationItem | undefined): string {
  const content = (ci?.item as { content?: unknown } | undefined)?.content
  return typeof content === 'string' ? content : ''
}

function awaitingPlan(title: string): PlanSnapshot {
  return {
    id: 'plan-approval',
    title,
    objective: '完成工作',
    status: 'awaiting_approval',
    revision: 3,
    requiresApproval: true,
    createdAt: 1,
    updatedAt: 2,
    stages: [{
      id: 'implement',
      title: '实现',
      objective: '完成代码',
      deliverables: [],
      dependencies: [],
      status: 'pending',
      evidence: [],
    }],
  }
}

afterEach(() => {
  // 隔离实例（A/B）随用例 GC；只复原本文件配置过的共享 defaultCore。
  defaultCore.abort.reset()
  Object.assign(defaultCore.config, {
    deepseekApiKey: '',
    glmApiKey: '',
    customInstructions: '',
    fetchImpl: undefined,
  })
  resetPersistence()
  resetObservability()
})

describe('双实例隔离证明（createCore × 真主循环 × 假 fetch）', () => {
  it('两实例各跑一轮同 id "s" 的真实对话：sessions/items/run/checkpoints/apiKey 全按实例隔离，defaultCore 零污染', async () => {
    const a = replyFetch('A-reply')
    const b = replyFetch('B-reply')
    // config 预置各自的 apiKey + fetchImpl —— 命令读【自己】的 core.config，与 defaultCore 无关。
    const A = createCore({ config: { deepseekApiKey: 'KA', fetchImpl: a.fetchImpl } })
    const B = createCore({ config: { deepseekApiKey: 'KB', fetchImpl: b.fetchImpl } })

    // 故意同 id "s"，且给不同 title —— 共享 rootStore 会让后写覆盖先写，立刻暴露。
    seedSession(A, 's', 'A-session')
    seedSession(B, 's', 'B-session')

    // 真命令并发触发（fire-and-forget）：各自读自己 config 的 apiKey/fetchImpl、beginRun 自己的 abort、
    //   以自己作 core 跑真 runToolLoop。并发对撞同一个 id —— 共享 abort 会互相掐 run、共享 store 会把两段
    //   对话堆进同一条 items。
    A.sendMessage('A-question')
    B.sendMessage('B-question')

    await waitUntil(
      () =>
        A.getSessionStore('s').store.getter(runAtom)?.status === 'done' &&
        B.getSessionStore('s').store.getter(runAtom)?.status === 'done',
      '两个 run 都 done',
    )

    // —— rootStore.sessionsAtom 隔离：各自只有自己登记的 's'，且读到的是【自己那份】meta ——
    expect(Object.keys(A.rootStore.getter(sessionsAtom))).toEqual(['s'])
    expect(A.rootStore.getter(sessionsAtom).s?.title).toBe('A-session')
    expect(Object.keys(B.rootStore.getter(sessionsAtom))).toEqual(['s'])
    expect(B.rootStore.getter(sessionsAtom).s?.title).toBe('B-session')

    // —— itemsAtom 隔离：A 的 's' 只含 A 的一轮，B 的只含 B 的一轮，互不夹带对方条目 ——
    const aItems = A.getSessionStore('s').store.getter(itemsAtom)
    const bItems = B.getSessionStore('s').store.getter(itemsAtom)
    expect(roles(aItems)).toEqual(['user', 'assistant'])
    expect(textOf(aItems[0])).toBe('A-question')
    expect(textOf(aItems[1])).toBe('A-reply')
    expect(roles(bItems)).toEqual(['user', 'assistant'])
    expect(textOf(bItems[0])).toBe('B-question')
    expect(textOf(bItems[1])).toBe('B-reply')
    // 反向钉死：A 里绝无 B 的任何文本，B 里绝无 A 的（共享 store 会让这两条红）。
    expect(JSON.stringify(aItems)).not.toContain('B-question')
    expect(JSON.stringify(aItems)).not.toContain('B-reply')
    expect(JSON.stringify(bItems)).not.toContain('A-question')
    expect(JSON.stringify(bItems)).not.toContain('A-reply')

    // —— runAtom 隔离：各自 done，且 runId 各不相同（同一 store 只会有一个 runId）——
    const aRun = A.getSessionStore('s').store.getter(runAtom)
    const bRun = B.getSessionStore('s').store.getter(runAtom)
    expect(aRun?.status).toBe('done')
    expect(bRun?.status).toBe('done')
    expect(aRun?.runId).toBeTruthy()
    expect(aRun?.runId).not.toBe(bRun?.runId)

    // —— checkpoints 隔离：各 1 条，各自快照只含自己那轮 ——
    const aCk = A.getSessionStore('s').store.getter(checkpointsAtom)
    const bCk = B.getSessionStore('s').store.getter(checkpointsAtom)
    expect(aCk).toHaveLength(1)
    expect(bCk).toHaveLength(1)
    expect(roles(aCk[0].items)).toEqual(['user', 'assistant'])
    expect(textOf(aCk[0].items.at(-1))).toBe('A-reply')
    expect(textOf(bCk[0].items.at(-1))).toBe('B-reply')

    // —— apiKey 隔离（一路穿到线上 Authorization）：A 只用 KA、B 只用 KB ——
    expect(a.auths).toEqual(['Bearer KA'])
    expect(b.auths).toEqual(['Bearer KB'])

    // —— defaultCore 全程零污染：既没登记 's'，惰性建出的 's' store 也空（没有任何一路写到它）——
    expect(defaultCore.rootStore.getter(sessionsAtom).s).toBeUndefined()
    expect(defaultCore.getSessionStore('s').store.getter(itemsAtom)).toEqual([])
    expect(defaultCore.getSessionStore('s').store.getter(runAtom)).toBeUndefined()
    expect(defaultCore.getSessionStore('s').store.getter(checkpointsAtom)).toEqual([])
  })

  it('abort 隔离：A 起 run 只动 A 自己的 abort，B 与 defaultCore 的 abort 全程不被触碰', async () => {
    const a = replyFetch('A-reply')
    const A = createCore({ config: { deepseekApiKey: 'KA', fetchImpl: a.fetchImpl } })
    const B = createCore({ config: { deepseekApiKey: 'KB' } })

    // spy 三套 abort：只有 A 自己的该被调。
    const beginA: string[] = []
    const beginB: string[] = []
    const beginDefault: string[] = []
    const origA = A.abort.beginRun
    const origB = B.abort.beginRun
    const origDefault = defaultCore.abort.beginRun
    A.abort.beginRun = (id: string) => {
      beginA.push(id)
      return origA(id)
    }
    B.abort.beginRun = (id: string) => {
      beginB.push(id)
      return origB(id)
    }
    defaultCore.abort.beginRun = (id: string) => {
      beginDefault.push(id)
      return origDefault(id)
    }

    // try/finally：断言中途抛也必还原被 patch 的方法引用——否则 patch 会泄漏到后续用例
    //   （afterEach 的 abort.reset() 只清 controller Map、不还原方法引用）。
    try {
      seedSession(A, 's', 'A-session')
      A.sendMessage('A-question')
      await waitUntil(() => A.getSessionStore('s').store.getter(runAtom)?.status === 'done', 'A done')

      expect(beginA).toEqual(['s']) // A 自己的 abort 被 beginRun('s')
      expect(beginB).toEqual([]) // 另一实例的 abort 纹丝不动
      expect(beginDefault).toEqual([]) // 全局默认实例的 abort 也纹丝不动
      // A 的 run 收尾后（.finally endRun）自己的 controller 已释放，B 的 abort 从头到尾没跑过任何 run。
      expect(A.abort.isRunning('s')).toBe(false)
      expect(B.abort.isRunning('s')).toBe(false)
      expect(defaultCore.abort.isRunning('s')).toBe(false)
    } finally {
      A.abort.beginRun = origA
      B.abort.beginRun = origB
      defaultCore.abort.beginRun = origDefault
    }
  })

  it('tools 隔离：两实例 + defaultCore 是三个不同的 registry 实例，各自独立填充互不串台', () => {
    // 【登记反转 · TS1/TS2】core 不再硬编码工具——用 fake 验证 registry 隔离：A/B 各注入自己的 fake，
    // defaultCore 由 test/setup.ts 装标准工具。标准工具集完整性由 @web-agent/tools 的 index.test 覆盖。
    const A = createCore({ registerTools: (r) => r.register(makeTool('only_a')) })
    const B = createCore({ registerTools: (r) => r.register(makeTool('only_b')) })

    // 三个不同的注册表实例（漏穿 core 让它们共享同一个 registry 会让这些 not.toBe 红）。
    expect(A.tools).not.toBe(B.tools)
    expect(A.tools).not.toBe(defaultCore.tools)
    expect(B.tools).not.toBe(defaultCore.tools)

    // 各自的 fake 只在自己那份 registry：不串到另一实例、也不串到 defaultCore。
    expect(A.tools.has('only_a')).toBe(true)
    expect(B.tools.has('only_a')).toBe(false)
    expect(defaultCore.tools.has('only_a')).toBe(false)
    expect(B.tools.has('only_b')).toBe(true)
    expect(A.tools.has('only_b')).toBe(false)
    // defaultCore 经 setup.ts 装了标准工具（非空），与 A/B 的 fake 集互不重叠。
    expect(defaultCore.tools.list().length).toBeGreaterThan(0)
  })

  it('atom 变更按实例隔离：直接订阅各自 store 的 itemsAtom，A 的订阅只见 A 的增量、B 只见 B 的', async () => {
    // 说明（残留缺口）：core/events.ts 的 subscribeAgentEvents 走的是【模块级】getSessionStore
    //   （= defaultCore 视图），并非 core-aware —— 用它订阅 's' 只会盯着 defaultCore 的 's'（本测里恒空）。
    //   故这里直接订阅各实例自己 store 的 itemsAtom，证明「事件的底料（atom 变更）」本就按实例隔离。
    //   ★ 标题刻意说「atom 变更」而非「事件流 API」：subscribeAgentEvents 尚未 core-aware，本测证的是前者。
    const a = replyFetch('A-reply')
    const b = replyFetch('B-reply')
    const A = createCore({ config: { deepseekApiKey: 'KA', fetchImpl: a.fetchImpl } })
    const B = createCore({ config: { deepseekApiKey: 'KB', fetchImpl: b.fetchImpl } })

    seedSession(A, 's', 'A-session')
    seedSession(B, 's', 'B-session')

    const seenA: string[] = []
    const seenB: string[] = []
    const storeA = A.getSessionStore('s').store
    const storeB = B.getSessionStore('s').store
    let lastA = storeA.getter(itemsAtom).length
    let lastB = storeB.getter(itemsAtom).length
    const unsubA = storeA.sub(itemsAtom, () => {
      const next = storeA.getter(itemsAtom)
      for (const it of next.slice(lastA)) seenA.push(textOf(it))
      lastA = next.length
    })
    const unsubB = storeB.sub(itemsAtom, () => {
      const next = storeB.getter(itemsAtom)
      for (const it of next.slice(lastB)) seenB.push(textOf(it))
      lastB = next.length
    })

    A.sendMessage('A-question')
    B.sendMessage('B-question')
    await waitUntil(
      () =>
        A.getSessionStore('s').store.getter(runAtom)?.status === 'done' &&
        B.getSessionStore('s').store.getter(runAtom)?.status === 'done',
      '两个 run 都 done',
    )
    unsubA()
    unsubB()

    // A 的订阅只收到 A 的增量（user+assistant），B 的只收到 B 的 —— 一条都不串。
    expect(seenA).toEqual(['A-question', 'A-reply'])
    expect(seenB).toEqual(['B-question', 'B-reply'])
  })

  it('persistence checkpoint 按实例隔离：A 的 turn snapshot 不会写入 defaultCore driver', async () => {
    const defaultPersistence = persistenceSpies()
    const aPersistence = persistenceSpies()
    configurePersistence({ history: defaultPersistence.history })
    const A = createCore({ config: { deepseekApiKey: 'KA', fetchImpl: replyFetch('A-reply').fetchImpl } })
    A.persistence.configure({ history: aPersistence.history })
    seedSession(A, 's', 'A-session')

    A.sendMessage('A-question')
    await waitUntil(() => A.getSessionStore('s').store.getter(runAtom)?.status === 'done', 'A done')

    expect(aPersistence.saveCheckpoint).toHaveBeenCalledWith(
      's',
      expect.objectContaining({ items: expect.any(Array) }),
    )
    expect(defaultPersistence.saveCheckpoint).not.toHaveBeenCalled()
  })

  it('persistence sessions 按实例隔离：A/B 的 commit snapshots 只写各自 driver，defaultCore 零污染', async () => {
    const defaultPersistence = persistenceSpies()
    const aPersistence = persistenceSpies()
    const bPersistence = persistenceSpies()
    configurePersistence({ sessions: defaultPersistence.sessions })
    const A = createCore({ config: { deepseekApiKey: 'KA', fetchImpl: replyFetch('A-reply').fetchImpl } })
    const B = createCore({ config: { deepseekApiKey: 'KB', fetchImpl: replyFetch('B-reply').fetchImpl } })
    A.persistence.configure({ sessions: aPersistence.sessions })
    B.persistence.configure({ sessions: bPersistence.sessions })
    seedSession(A, 's', 'A-session')
    seedSession(B, 's', 'B-session')

    A.sendMessage('A-question')
    B.sendMessage('B-question')
    await waitUntil(
      () =>
        A.getSessionStore('s').store.getter(runAtom)?.status === 'done' &&
        B.getSessionStore('s').store.getter(runAtom)?.status === 'done',
      '两个 run 都 done',
    )

    expect(aPersistence.saveSessions).toHaveBeenCalledWith([expect.objectContaining({ title: 'A-session' })])
    expect(bPersistence.saveSessions).toHaveBeenCalledWith([expect.objectContaining({ title: 'B-session' })])
    expect(defaultPersistence.saveSessions).not.toHaveBeenCalled()
  })

  it('approvePlan 只读取并更新绑定实例的同 id 计划，不串到 defaultCore', () => {
    const A = createCore({ config: { deepseekApiKey: 'KA', fetchImpl: replyFetch('A-reply').fetchImpl } })
    seedSession(A, 's', 'A-session')
    seedSession(defaultCore, 's', 'default-session')
    setPlan('s', awaitingPlan('A plan'), A)
    setPlan('s', awaitingPlan('default plan'), defaultCore)
    A.getSessionStore('s').store.setter(runAtom, {
      runId: 'R-plan',
      status: 'waiting_plan_approval',
      pendingPlanApproval: { callId: 'plan-call', planId: 'plan-approval', revision: 3 },
    })

    A.approvePlan(true)

    expect(getPlan('s', A)).toMatchObject({ title: 'A plan', status: 'approved', revision: 4 })
    expect(getPlan('s', defaultCore)).toMatchObject({ title: 'default plan', status: 'awaiting_approval', revision: 3 })
    A.stopRun()
  })
})
