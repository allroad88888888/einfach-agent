import { describe, expect, it } from 'vitest'

import { rootStore, sessionsAtom } from '../../state/rootStore'
import { getSessionStore } from '../../state/sessionStore'
import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import { appendItem, setRun, setRunStatus } from '../../state/sessionWriters'
import type { ConversationItem, RunState } from '../../state/core.type'
import { isRunEndStatus, subscribeAgentEvents, type AgentEvent } from './events'

// events 投影器（PX5）—— 纯观察：从 itemsAtom / runAtom 无损派生规范化 AgentEvent。
// 用【真 store】（getSessionStore，与投影器同一实例）驱动；部分用例走真 writer + seedSession
// 验证生产路径。共享 store 由测试 setup 在每个用例后复位。

// 在 rootStore 登记表里 seed 一个会话（真 writer 的 ghost guard 需要它才不 no-op）。
function seedSession(id = 's1'): void {
  rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 't',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
    },
  })
}

// 最小合法 ConversationItem（UserItem 只需 role + content）。
function item(id: string): ConversationItem {
  return { id, createdAt: 1, item: { role: 'user', content: id } }
}

function run(runId: string, status: RunState['status'], error?: string): RunState {
  return error === undefined ? { runId, status } : { runId, status, error }
}

// 收集回调事件的最小夹具。
function collect(sessionId = 's1'): { events: AgentEvent[]; unsubscribe: () => void } {
  const events: AgentEvent[] = []
  const unsubscribe = subscribeAgentEvents(sessionId, (e) => events.push(e))
  return { events, unsubscribe }
}

describe('isRunEndStatus（终态 / 等待态分类）', () => {
  it('终态 / 等待态 → true', () => {
    for (const s of ['done', 'error', 'stopped', 'waiting_user', 'waiting_confirmation', 'waiting_plan_approval'] as const) {
      expect(isRunEndStatus(s)).toBe(true)
    }
  })

  it('活跃 / 过渡态 → false（不发 run_end）', () => {
    for (const s of ['idle', 'running', 'awaiting_tool'] as const) {
      expect(isRunEndStatus(s)).toBe(false)
    }
  })
})

describe('subscribeAgentEvents —— message_appended 增量 diff', () => {
  it('订阅后 append 一条 → 收到一条 message_appended（不是全量）', () => {
    const store = getSessionStore('s1').store
    const { events } = collect()

    const a = item('a')
    store.setter(itemsAtom, [a])

    expect(events).toEqual([{ type: 'message_appended', item: a }])
    // 断言是【原条目引用】，不是拷贝。
    expect((events[0] as { item: ConversationItem }).item).toBe(a)
  })

  it('连续 append → 只收增量（第二次不重发第一条）', () => {
    const store = getSessionStore('s1').store
    const { events } = collect()

    const a = item('a')
    const b = item('b')
    store.setter(itemsAtom, [a])
    store.setter(itemsAtom, [a, b])

    // 关键变异自检点：若把增量 diff 改成全量重发，这里会变成 [a, a, b]。
    expect(events).toEqual([
      { type: 'message_appended', item: a },
      { type: 'message_appended', item: b },
    ])
  })

  it('一次 append 多条 → 逐条发出这批新增', () => {
    const store = getSessionStore('s1').store
    store.setter(itemsAtom, [item('a')])
    const { events } = collect()

    const b = item('b')
    const c = item('c')
    store.setter(itemsAtom, [item('a'), b, c])

    expect(events).toEqual([
      { type: 'message_appended', item: b },
      { type: 'message_appended', item: c },
    ])
  })

  it('订阅前已有的历史不重放（只投影订阅之后的新增）', () => {
    const store = getSessionStore('s1').store
    store.setter(itemsAtom, [item('a'), item('b')]) // 订阅前
    const { events } = collect()

    const c = item('c')
    store.setter(itemsAtom, [item('a'), item('b'), c])

    expect(events).toEqual([{ type: 'message_appended', item: c }])
  })

  it('等长替换（in-place update）不发 message_appended', () => {
    const store = getSessionStore('s1').store
    store.setter(itemsAtom, [item('a'), item('b')])
    const { events } = collect()

    // 替换末尾条目但长度不变 —— 是「更新」不是「新增」。
    store.setter(itemsAtom, [item('a'), { ...item('b'), createdAt: 999 }])
    expect(events).toEqual([])

    // 之后正常 append 仍只发增量。
    const c = item('c')
    store.setter(itemsAtom, [item('a'), { ...item('b'), createdAt: 999 }, c])
    expect(events).toEqual([{ type: 'message_appended', item: c }])
  })

  it('截断 / revert 不发；revert 后再 append 只发新增（基线已对齐）', () => {
    const store = getSessionStore('s1').store
    store.setter(itemsAtom, [item('a'), item('b'), item('c')])
    const { events } = collect()

    store.setter(itemsAtom, [item('a')]) // revert 到第 1 条
    expect(events).toEqual([]) // 截断本身不发

    const d = item('d')
    store.setter(itemsAtom, [item('a'), d])
    expect(events).toEqual([{ type: 'message_appended', item: d }])
  })

  it('前缀被替换的「变长」不算 append（不重放整段）', () => {
    const store = getSessionStore('s1').store
    store.setter(itemsAtom, [item('a'), item('b')])
    const { events } = collect()

    // 长度 2→3 但前缀（下标 0/1）已换成不同 id —— 不是纯 append，不发。
    store.setter(itemsAtom, [item('x'), item('y'), item('z')])
    expect(events).toEqual([])
  })
})

describe('subscribeAgentEvents —— run 生命周期', () => {
  it('running → done：先 run_start 后 run_end，夹着 status_changed', () => {
    const store = getSessionStore('s1').store
    const { events } = collect()

    store.setter(runAtom, run('r1', 'running'))
    store.setter(runAtom, run('r1', 'done'))

    expect(events).toEqual([
      { type: 'run_start', runId: 'r1' },
      { type: 'run_status_changed', status: 'running' },
      { type: 'run_status_changed', status: 'done' },
      { type: 'run_end', runId: 'r1', status: 'done' },
    ])
  })

  it('多轮 running↔awaiting_tool 往返：run_start 只发一次', () => {
    const store = getSessionStore('s1').store
    const { events } = collect()

    store.setter(runAtom, run('r1', 'running'))
    store.setter(runAtom, run('r1', 'awaiting_tool'))
    store.setter(runAtom, run('r1', 'running'))
    store.setter(runAtom, run('r1', 'done'))

    const starts = events.filter((e) => e.type === 'run_start')
    expect(starts).toEqual([{ type: 'run_start', runId: 'r1' }])
    // awaiting_tool 只推进，不发 run_end；done 才发一次 run_end。
    expect(events.filter((e) => e.type === 'run_end')).toEqual([
      { type: 'run_end', runId: 'r1', status: 'done' },
    ])
  })

  it('进入 waiting_user 发 run_end；resume 回 running 不重发 run_start', () => {
    const store = getSessionStore('s1').store
    const { events } = collect()

    store.setter(runAtom, run('r1', 'running'))
    store.setter(runAtom, run('r1', 'waiting_user'))
    store.setter(runAtom, run('r1', 'running')) // resume
    store.setter(runAtom, run('r1', 'done'))

    expect(events.filter((e) => e.type === 'run_start')).toHaveLength(1)
    // waiting_user + done 各闭合一段 → 两次 run_end。
    expect(events.filter((e) => e.type === 'run_end')).toEqual([
      { type: 'run_end', runId: 'r1', status: 'waiting_user' },
      { type: 'run_end', runId: 'r1', status: 'done' },
    ])
  })

  it('run_status_changed 携带 error 串（出错收尾）', () => {
    const store = getSessionStore('s1').store
    const { events } = collect()

    store.setter(runAtom, run('r1', 'running'))
    store.setter(runAtom, run('r1', 'error', 'boom'))

    expect(events).toContainEqual({ type: 'run_status_changed', status: 'error', error: 'boom' })
    expect(events).toContainEqual({ type: 'run_end', runId: 'r1', status: 'error' })
  })

  it('非 status 变化（如仅 loadedTools 变）不发 run_status_changed', () => {
    const store = getSessionStore('s1').store
    store.setter(runAtom, { runId: 'r1', status: 'running' })
    const { events } = collect()

    store.setter(runAtom, { runId: 'r1', status: 'running', loadedTools: ['x'] })
    expect(events).toEqual([]) // status 没变 → 不发任何事件
  })

  it('新 runId 起新 run → 发一条新的 run_start', () => {
    const store = getSessionStore('s1').store
    const { events } = collect()

    store.setter(runAtom, run('r1', 'running'))
    store.setter(runAtom, run('r1', 'done'))
    store.setter(runAtom, run('r2', 'running'))

    expect(events.filter((e) => e.type === 'run_start')).toEqual([
      { type: 'run_start', runId: 'r1' },
      { type: 'run_start', runId: 'r2' },
    ])
  })

  it('直接进入终态（从未 running）→ 发 run_end 但不合成 run_start', () => {
    const store = getSessionStore('s1').store
    const { events } = collect()

    store.setter(runAtom, run('r1', 'error', 'early'))

    expect(events.some((e) => e.type === 'run_start')).toBe(false)
    expect(events).toContainEqual({ type: 'run_end', runId: 'r1', status: 'error' })
  })
})

describe('subscribeAgentEvents —— unsubscribe / 隔离 / 生产路径', () => {
  it('unsubscribe 后不再收到任何事件', () => {
    const store = getSessionStore('s1').store
    const { events, unsubscribe } = collect()

    unsubscribe()
    store.setter(itemsAtom, [item('a')])
    store.setter(runAtom, run('r1', 'running'))

    expect(events).toEqual([])
  })

  it('只观察本会话 store —— 另一会话的写入不泄漏', () => {
    const { events } = collect('s1')

    const otherStore = getSessionStore('s2').store
    otherStore.setter(itemsAtom, [item('a')])
    otherStore.setter(runAtom, run('r1', 'running'))

    expect(events).toEqual([])
  })

  it('生产路径：真 writer（appendItem / setRun / setRunStatus）驱动也能观察到', () => {
    seedSession('s1')
    const { events } = collect('s1')

    const a = item('a')
    appendItem('s1', a)
    setRun('s1', run('r1', 'running'))
    setRunStatus('s1', 'done')

    expect(events).toEqual([
      { type: 'message_appended', item: a },
      { type: 'run_start', runId: 'r1' },
      { type: 'run_status_changed', status: 'running' },
      { type: 'run_status_changed', status: 'done' },
      { type: 'run_end', runId: 'r1', status: 'done' },
    ])
  })
})
