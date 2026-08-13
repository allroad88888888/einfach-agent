// 拆分自 modelRun.test.ts（T1）。原文件同名 describe 段落逐字迁移。

import { describe, it, expect, afterEach } from 'vitest'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom, checkpointsAtom } from '../state/sessionAtoms'
import { setRun } from '../state/sessionWriters'
import { runSession } from './modelRun'
import { configureObservability, flushObservability } from '../observability/trace'
import { resetModelRunTestState, captureCheckpointPersistence, seedSession, jsonResponse, finishReasonResponse, rawToolCallsResponse, seqFetch, captureTrace, sseResponse } from './modelRun.testHarness'

afterEach(() => {
  resetModelRunTestState()
})

// ---------------------------------------------------------------------------
// finish_reason 异常三态（length / content_filter / insufficient_system_resource）
// ---------------------------------------------------------------------------
describe('finish_reason 异常分流', () => {
  it("length 且无 tool_calls：保留半截回复 + status=error，且整轮照常 commit 并落盘", async () => {
    const persistence = captureCheckpointPersistence()
    seedSession('fr1', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, count } = seqFetch([() => finishReasonResponse('length', '半截答案')])

    await runSession('fr1', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('fr1').store
    const items = store.getter(itemsAtom)
    // 半截内容必须留下 —— 用户得看得见模型说到哪被掐断的。
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant'])
    const assistantItem = items[2].item
    if (assistantItem.role !== 'assistant') throw new Error('意外的条目形状')
    expect(assistantItem.content).toContain('半截答案')
    const run = store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('finish_reason=length')
    // ★ 回归（MAJOR）：itemsAtom 不持久化，落盘的唯一入口就是 commitCheckpoint + persistCheckpoint。
    //   这一轮若不落盘，用户刷新后不只半截答案没了，连他自己发的那条 user 消息也一起消失。
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
    expect(store.getter(checkpointsAtom)[0].items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant'])
    expect(persistence.saved).toHaveLength(3)
    expect(persistence.saved.at(-1)?.sessionId).toBe('fr1')
    expect(persistence.saved.at(-1)?.checkpoint.items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant'])
    // 状态仍是 error（落盘不代表这轮算成功），也不再发第二次请求。
    expect(count()).toBe(1)
  })

  it('length 且流式：末尾未 flush 的文本必须补齐（不能只留最后一次节流快照）', async () => {
    seedSession('fr-stream', { vendor: 'deepseek', model: 'x' })
    // 两个 delta 在同一批 SSE 里被同步消费 —— 间隔远小于 STREAM_UPDATE_INTERVAL_MS(50ms)，
    // 于是第二次 flush 被节流丢掉，条目里只剩「前半段」。收尾必须把完整内容对账回去。
    const fetchImpl: typeof fetch = async () =>
      sseResponse([
        { choices: [{ delta: { content: '前半段' } }] },
        { choices: [{ delta: { content: '后半段' }, finish_reason: 'length' }] },
      ])

    await runSession('fr-stream', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('fr-stream').store
    const items = store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant'])
    // ★ 回归（MAJOR）：finishPending() 只写 { pending:false }、从不写 content，
    //   末尾那段文字只活在 streamWriter 闭包里 —— 界面会比实际收到的还少一截且毫无提示。
    const streamedItem = items[2].item
    if (streamedItem.role !== 'assistant') throw new Error('意外的条目形状')
    expect(streamedItem.content).toContain('前半段后半段')
    // 系统标注只能【追加】在完整正文之后，不能把流式对账出来的文本顶掉。
    expect(streamedItem.content?.startsWith('前半段后半段')).toBe(true)
    expect(items[2].pending).toBe(false)
    // 半截 assistant 条目绝不能带 tool_calls：本分支要 return、不执行工具，
    // 落下 tool_calls 就成了没有 result 的孤儿，下一轮重发直接被接口判非法。
    expect('tool_calls' in items[2].item).toBe(false)
    const run = store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('finish_reason=length')
  })

  it('length 且内容为空：报「触顶截断」而不是误导性的「模型返回空回复」', async () => {
    seedSession('fr2', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () => finishReasonResponse('length', '')

    await runSession('fr2', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const run = getSessionStore('fr2').store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('finish_reason=length')
    expect(run?.error).not.toContain('空回复')
  })

  it('content_filter：status=error 且文案点名内容安全策略，content 为空仍补「仅含标注」的 assistant 条目', async () => {
    seedSession('fr3', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () => finishReasonResponse('content_filter', null)

    await runSession('fr3', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('fr3').store
    const run = store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('content_filter')
    // ★ 回归：content 为 null（content_filter 的正常形态）不再意味着「什么条目都不留」——
    //   同 length 一样必须有落点，否则刷新后聊天区一片空白，且下一轮重发历史时模型看不出
    //   这里发生过什么（见 modelRun.ts 该分支的长注释）。
    const items = store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant'])
    const assistantItem = items[2].item
    if (assistantItem.role !== 'assistant') throw new Error('意外的条目形状')
    expect(assistantItem.content).toContain('content_filter')
    expect(assistantItem.content).toContain('系统标注')
    // 没有原始正文可拼接时，不应该让这条独立条目从一段空白换行起头。
    expect(assistantItem.content?.startsWith('\n')).toBe(false)
    // ★ 指代必须是「本轮回复」而不是「以上回复」★ ——
    //   这条是【独立条目】，它上面一条消息是用户的提问。说「以上回复被拦截」会指到用户身上：
    //   重发历史时模型看到 user → assistant('以上回复被拦截')，很可能理解成「用户的输入被拦截」，
    //   与「让模型知道自己上一轮输出出了什么事」的目标正好相反。
    expect(assistantItem.content).toContain('本轮回复')
    expect(assistantItem.content).not.toContain('以上回复')
  })

  it('容量响应抵达时已 abort：adapter 守卫不得发送第二个请求', async () => {
    seedSession('fr-resource-abort', { vendor: 'deepseek', model: 'x' })
    const controller = new AbortController()
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      controller.abort()
      return finishReasonResponse('insufficient_system_resource', null)
    }

    await runSession('fr-resource-abort', 'hi', {
      signal: controller.signal,
      apiKey: 'k',
      fetchImpl,
    })

    expect(calls).toBe(1)
    expect(getSessionStore('fr-resource-abort').store.getter(runAtom)?.status).toBe('stopped')
  })

  it('容量响应抵达后 run 已过期：adapter 守卫不得为新 run 重试', async () => {
    seedSession('fr-resource-stale', { vendor: 'deepseek', model: 'x' })
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls += 1
      setRun('fr-resource-stale', { runId: 'NEW-RUN', status: 'running' })
      return finishReasonResponse('insufficient_system_resource', null)
    }

    await runSession('fr-resource-stale', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    expect(calls).toBe(1)
    expect(getSessionStore('fr-resource-stale').store.getter(runAtom)).toMatchObject({
      runId: 'NEW-RUN',
      status: 'running',
    })
  })

  it('content_filter 补条目：刷新（落盘）和下一轮重发给模型都看得见「这里被拦截过」', async () => {
    const persistence = captureCheckpointPersistence()
    seedSession('fr-cf-mark', { vendor: 'deepseek', model: 'x' })
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = []
    let calls = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string))
      calls += 1
      return calls === 1 ? finishReasonResponse('content_filter', null) : jsonResponse('续上')
    }

    await runSession('fr-cf-mark', '敏感问题', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('fr-cf-mark').store
    // ★ 回归 a：checkpoint（落盘的唯一真相源）里必须带着这条「仅含标注」的 assistant 条目，
    //   同时把异常状态写进结构化字段——否则刷新后聊天区看起来这轮什么都没发生。
    const checkpoint = store.getter(checkpointsAtom)[0]
    expect(checkpoint).toMatchObject({ label: '敏感问题', kind: 'abnormal', finishReason: 'content_filter' })
    const committedAssistant = checkpoint.items[2].item
    if (committedAssistant.role !== 'assistant') throw new Error('意外的条目形状')
    expect(String(committedAssistant.content)).toContain('content_filter')
    expect(persistence.saved).toHaveLength(3)
    const savedAssistant = persistence.saved.at(-1)!.checkpoint.items[2].item
    if (savedAssistant.role !== 'assistant') throw new Error('意外的条目形状')
    expect(String(savedAssistant.content)).toContain('content_filter')

    // ★ 回归 b（更要紧）：下一轮重发给模型的历史里必须能看见这条标注，模型才知道
    //   「上一轮被内容安全策略拦截了」，而不是把两条 user 消息中间的空白当成什么都没发生过。
    await runSession('fr-cf-mark', '继续', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    const resent = bodies[bodies.length - 1].messages
    const resentAssistant = resent.find(
      (message) => message.role === 'assistant' && String(message.content).includes('content_filter'),
    )
    expect(resentAssistant).toBeDefined()
  })

  it('length 且带 tool_calls：不终止（终止会留下没有结果的 tool_calls），交给参数解析兜底', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('fr5', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      // arguments 被截断成半截 JSON —— 正是 finish_reason='length' 的典型产物。
      () => rawToolCallsResponse('length', [{ name: 'skill_search', args: '{"query": "cha', id: 'cut1' }]),
      () => jsonResponse('已重来'),
    ])

    await runSession('fr5', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    await flushObservability()

    const store = getSessionStore('fr5').store
    const items = store.getter(itemsAtom)
    // 关键：assistant(tool_calls) 后必须有对应的 tool 结果，否则下一轮消息序列非法。
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant', 'tool', 'assistant'])
    const toolItem = items[3].item
    if (toolItem.role !== 'tool') throw new Error('意外的条目形状')
    expect(toolItem.tool_call_id).toBe('cut1')
    const payload = JSON.parse(toolItem.content) as Record<string, unknown>
    expect(String(payload.error)).toContain('不是合法 JSON')
    expect(String(payload.argumentsPreview)).toContain('"query"')
    // 循环继续（TK6），模型重发后正常收尾。
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(trace.events.some((event) => event.name === 'llm.finish_length_tool_calls')).toBe(true)
    expect(trace.events.some((event) => event.name === 'tool.args_invalid')).toBe(true)
  })

  it('截断标记进持久化：正文带系统标注 + checkpoint 结构化状态，且重发给模型时仍看得见', async () => {
    const persistence = captureCheckpointPersistence()
    seedSession('fr-mark', { vendor: 'deepseek', model: 'x' })
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = []
    let calls = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(init!.body as string))
      calls += 1
      return calls === 1 ? finishReasonResponse('length', '第一步先算出 42') : jsonResponse('续上')
    }

    await runSession('fr-mark', '算个数', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('fr-mark').store
    // ★ 回归 a（MAJOR）：承载 finishError 的 runAtom 不持久化，截断状态必须落在【持久化数据】上，
    //   否则刷新之后这半截回答与一条正常回复完全同形，CheckpointBar 上也分不出好坏。
    const checkpoint = store.getter(checkpointsAtom)[0]
    expect(checkpoint).toMatchObject({ label: '算个数', kind: 'abnormal', finishReason: 'length' })
    const committedAssistant = checkpoint.items[2].item
    if (committedAssistant.role !== 'assistant') throw new Error('意外的条目形状')
    expect(String(committedAssistant.content)).toContain('第一步先算出 42')
    expect(String(committedAssistant.content)).toContain('finish_reason=length')
    // 落盘的那一份（刷新后唯一的真相源）必须同样带着标注与结构化状态。
    expect(persistence.saved).toHaveLength(3)
    expect(persistence.saved.at(-1)?.checkpoint).toMatchObject({
      label: '算个数',
      kind: 'abnormal',
      finishReason: 'length',
    })
    const savedAssistant = persistence.saved.at(-1)!.checkpoint.items[2].item
    if (savedAssistant.role !== 'assistant') throw new Error('意外的条目形状')
    expect(String(savedAssistant.content)).toContain('finish_reason=length')

    // ★ 回归 b（更要紧）：这条半截文本会作为历史在之后每一轮被重发给模型。模型必须看得出
    //   「上文这里被截断过」，否则会把半截推理当成已成立的结论继续往下走。
    await runSession('fr-mark', '继续', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    const resent = bodies[bodies.length - 1].messages
    const resentAssistant = resent.find(
      (message) => message.role === 'assistant' && String(message.content).includes('第一步先算出 42'),
    )
    expect(resentAssistant).toBeDefined()
    expect(String(resentAssistant?.content)).toContain('finish_reason=length')
    // 标注只是【追加】—— 模型原话一字不改地留在前面。
    expect(String(resentAssistant?.content).startsWith('第一步先算出 42')).toBe(true)
  })

  it('正常轮不被标记污染：assistant 正文一字不加，checkpoint label 也不带前缀', async () => {
    seedSession('fr-clean', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () => jsonResponse('完整答案')

    await runSession('fr-clean', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('fr-clean').store
    expect(store.getter(itemsAtom)[2].item).toEqual({ role: 'assistant', content: '完整答案' })
    expect(store.getter(checkpointsAtom)[0].label).toBe('hi')
  })
})
