// 拆分自 modelRun.test.ts（T1）。原文件同名 describe 段落逐字迁移。

import { describe, it, expect, afterEach } from 'vitest'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { enqueueUserMessage } from '../state/transientAtoms'
import { toolRegistry } from '../tools/registry'
import { runSession } from './modelRun'
import { configureObservability, flushObservability } from '../observability/trace'
import { resetModelRunTestState, seedSession, jsonResponse, toolCallsResponse, captureTrace } from './modelRun.testHarness'

afterEach(() => {
  resetModelRunTestState()
})

// ---------------------------------------------------------------------------
// 工具连败软提醒
// ---------------------------------------------------------------------------
// 同一工具在一次 run 内失败达 TOOL_FAILURE_STREAK_THRESHOLD（现为 1，即每次失败）→ 下一轮请求
// 临时注入一条 system 提醒（只进请求投影，不写 itemsAtom）。它只提醒「先按错误提示自救」，
// 不终止 run —— 熔断职责仍在 loopGuard / max_turns。
// streak 计数仍按【连续】失败累计：只影响列表行文案（1 次「调用失败」／N 次「已连续失败 N 次」），
// 不影响是否注入。
// ★ 用例里同一工具的参数逐次变化 ★：同签名跨轮重复 3 次会先命中循环检测（阈值 3）而整轮 error，
//   那是另一条链路；这里要测的是「失败但每次都换参数」的软提醒。
describe('工具连败软提醒', () => {
  // 新文案的稳定锚点（指令句尾部），与 selfReflectionPrompts.toolFailureStreakNotice 对齐。
  const NOTICE_MARK = '不要原样重发同一调用'

  // 可控成败的测试工具：calls 从 1 开始计数，达到 succeedFrom 之后返回成功。
  function registerFlakyTool(
    name: string,
    error: string,
    options?: { parallel?: boolean },
  ): { calls: number; succeedFrom: number } {
    const state = { calls: 0, succeedFrom: Number.POSITIVE_INFINITY }
    toolRegistry.register({
      name,
      runtime: 'internal',
      ...(options?.parallel ? { execution: { mode: 'parallel' as const, effectKeys: ['test:read'] } } : {}),
      skill: { description: 'x', content: 'x' },
      inputSchema: { type: 'object' },
      execute() {
        state.calls += 1
        return state.calls >= state.succeedFrom
          ? { ok: true, data: { done: true } }
          : { ok: false, error }
      },
    })
    return state
  }

  // 每次请求体里的 system 文本 —— 提醒只存在于请求投影，断言只能从这里取。
  function captureSystemTexts(responses: Array<() => Response>): {
    fetchImpl: typeof fetch
    systemTexts: string[]
  } {
    const systemTexts: string[] = []
    let i = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(init!.body as string) as {
        messages: Array<{ role: string; content?: unknown }>
      }
      systemTexts.push(
        body.messages
          .filter((message) => message.role === 'system')
          .map((message) => String(message.content ?? ''))
          .join('\n'),
      )
      const maker = responses[Math.min(i, responses.length - 1)]
      i += 1
      return maker()
    }
    return { fetchImpl, systemTexts }
  }

  function loadToolCall(toolName: string, id: string): Response {
    return toolCallsResponse([{
      name: 'request_tool_schema',
      args: { toolName, reason: `加载 ${toolName}` },
      id,
    }])
  }

  it('失败 1 次 → 下一轮即注入；继续失败则列表行升为「已连续失败 N 次」', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    registerFlakyTool('__streak_fail_a__', 'ENOENT: 目标路径不存在')
    seedSession('streak-a', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, systemTexts } = captureSystemTexts([
      () => loadToolCall('__streak_fail_a__', 'load-a'),
      () => toolCallsResponse([{ name: '__streak_fail_a__', args: { attempt: 1 }, id: 'fail-a1' }]),
      () => toolCallsResponse([{ name: '__streak_fail_a__', args: { attempt: 2 }, id: 'fail-a2' }]),
      () => jsonResponse('这条路走不通，我说明一下阻塞原因'),
    ])

    await runSession('streak-a', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
    await flushObservability()

    // 4 次请求：加载 schema / 第 1 次失败 / 带 count=1 提醒的那一轮 / 带 count=2 提醒的那一轮。
    expect(systemTexts).toHaveLength(4)
    // 第 1 次失败之后的那一轮就要收到提醒（阈值 1：不再等第二败）。
    expect(systemTexts[2]).toContain('· __streak_fail_a__：调用失败；错误：ENOENT: 目标路径不存在')
    expect(systemTexts[2]).not.toContain('已连续失败')
    expect(systemTexts[2]).toContain(NOTICE_MARK)
    // 同一工具再败一次 → 列表行切到多次分支，仍然每轮都提醒。
    expect(systemTexts[3]).toContain('· __streak_fail_a__：已连续失败 2 次；最近一次错误：ENOENT: 目标路径不存在')
    expect(systemTexts[3]).toContain(NOTICE_MARK)
    // 提醒不熔断：run 仍照常收在最终答案上。
    expect(getSessionStore('streak-a').store.getter(runAtom)?.status).toBe('done')
    const events = trace.events.filter((e) => e.name === 'agent.tool_failure_notice')
    expect(events).toHaveLength(2)
    expect(events[0]?.attrs?.tools).toEqual([{ name: '__streak_fail_a__', count: 1 }])
    expect(events[1]?.attrs?.tools).toEqual([{ name: '__streak_fail_a__', count: 2 }])
  })

  it('只失败 1 次也注入，且那条提醒只发一轮（一次性消费）', async () => {
    registerFlakyTool('__streak_fail_b__', 'EPERM: 权限不足')
    const helper = registerFlakyTool('__streak_ok_b__', '不会走到这里')
    helper.succeedFrom = 1 // 一调即成功，代表模型读完提醒后改用别的方法
    seedSession('streak-b', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, systemTexts } = captureSystemTexts([
      () => loadToolCall('__streak_fail_b__', 'load-b1'),
      () => loadToolCall('__streak_ok_b__', 'load-b2'),
      () => toolCallsResponse([{ name: '__streak_fail_b__', args: { attempt: 1 }, id: 'fail-b1' }]),
      () => toolCallsResponse([{ name: '__streak_ok_b__', args: {}, id: 'ok-b1' }]),
      () => jsonResponse('好'),
    ])

    await runSession('streak-b', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(systemTexts).toHaveLength(5)
    // 单次失败就够：第 4 次请求带上 count=1 的提醒。
    expect(systemTexts[3]).toContain('· __streak_fail_b__：调用失败；错误：EPERM: 权限不足')
    expect(systemTexts[3]).toContain(NOTICE_MARK)
    // 一次性消费：整个 run 内这条提醒只出现在那一轮，不会每轮重放。
    expect(systemTexts.filter((text) => text.includes(NOTICE_MARK))).toHaveLength(1)
  })

  it('注入后该工具成功一次 → streak 清零，其后不再注入', async () => {
    const flaky = registerFlakyTool('__streak_fail_c__', 'ETIMEDOUT: 请求超时')
    flaky.succeedFrom = 3 // 前两次失败，第三次成功
    seedSession('streak-c', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, systemTexts } = captureSystemTexts([
      () => loadToolCall('__streak_fail_c__', 'load-c'),
      () => toolCallsResponse([{ name: '__streak_fail_c__', args: { attempt: 1 }, id: 'fail-c1' }]),
      () => toolCallsResponse([{ name: '__streak_fail_c__', args: { attempt: 2 }, id: 'fail-c2' }]),
      () => toolCallsResponse([{ name: '__streak_fail_c__', args: { attempt: 3 }, id: 'ok-c3' }]),
      () => jsonResponse('换了参数之后成功了'),
    ])

    await runSession('streak-c', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(systemTexts).toHaveLength(5)
    // 第 3、4 次请求各带一次提醒（分别是第 1、2 次失败的回声）；
    // 成功那一轮之后（第 5 次请求）必须清零、不再注入。
    expect(systemTexts[2]).toContain(NOTICE_MARK)
    expect(systemTexts[3]).toContain(NOTICE_MARK)
    expect(systemTexts[4]).not.toContain(NOTICE_MARK)
  })

  it('提醒是一次性消费：模型改道后不再被过时提醒骚扰', async () => {
    registerFlakyTool('__streak_fail_f__', 'ENOTDIR: 路径不是目录')
    const helper = registerFlakyTool('__streak_ok_f__', '不会走到这里')
    helper.succeedFrom = 1 // 这个工具一调即成功，用来代表「模型改用别的方法」
    seedSession('streak-f', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, systemTexts } = captureSystemTexts([
      () => loadToolCall('__streak_fail_f__', 'load-f1'),
      () => loadToolCall('__streak_ok_f__', 'load-f2'),
      () => toolCallsResponse([{ name: '__streak_fail_f__', args: { attempt: 1 }, id: 'fail-f1' }]),
      () => toolCallsResponse([{ name: '__streak_fail_f__', args: { attempt: 2 }, id: 'fail-f2' }]),
      // 这一轮模型收到提醒后改道：不再碰失败的工具，改用另一个工具并成功。
      () => toolCallsResponse([{ name: '__streak_ok_f__', args: {}, id: 'ok-f1' }]),
      () => jsonResponse('换了个方法，已经做完了'),
    ])

    await runSession('streak-f', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(systemTexts).toHaveLength(6)
    // 第 4 次请求：紧跟第 1 次失败（count=1 的单次分支）。
    expect(systemTexts[3]).toContain('· __streak_fail_f__：调用失败；错误：ENOTDIR: 路径不是目录')
    // 第 5 次请求：紧跟第 2 次失败（count=2 的多次分支）。
    expect(systemTexts[4]).toContain('· __streak_fail_f__：已连续失败 2 次')
    expect(systemTexts[4]).toContain(NOTICE_MARK)
    // 第 6 次请求：模型已改道并成功，那条提醒不得再发一遍（否则每轮都在重放过时噪音）。
    expect(systemTexts[5]).not.toContain(NOTICE_MARK)
  })

  it('用户中途插话 → 连败计数与待发提醒一并作废（新语境）', async () => {
    registerFlakyTool('__streak_fail_g__', 'EBUSY: 资源占用中')
    seedSession('streak-g', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, systemTexts } = captureSystemTexts([
      () => loadToolCall('__streak_fail_g__', 'load-g'),
      () => toolCallsResponse([{ name: '__streak_fail_g__', args: { attempt: 1 }, id: 'fail-g1' }]),
      () => {
        // 第 2 次失败即将发生（它会写入新的一条提醒）；先排入一条用户插话，
        // 下一轮边界的 promoteQueuedInputs 会把它提升成新语境并清空失败计数与待发提醒。
        const runId = getSessionStore('streak-g').store.getter(runAtom)?.runId
        enqueueUserMessage('streak-g', {
          id: 'q-streak-g',
          createdAt: Date.now(),
          content: '换个思路吧',
          targetRunId: runId!,
        })
        return toolCallsResponse([{ name: '__streak_fail_g__', args: { attempt: 2 }, id: 'fail-g2' }])
      },
      () => jsonResponse('好'),
    ])

    await runSession('streak-g', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const items = getSessionStore('streak-g').store.getter(itemsAtom)
    // 前置条件：插话确实被提升成了 user 消息（否则本用例证明不了「清零」）。
    expect(items.some((it) => it.item.role === 'user' && it.item.content === '换个思路吧')).toBe(true)
    expect(systemTexts).toHaveLength(4)
    // 正向对照：第 3 次请求带着第 1 次失败的提醒（此时还没插话）。
    expect(systemTexts[2]).toContain(NOTICE_MARK)
    // 第 4 次请求本该带第 2 次失败的提醒，但用户插话把语境清空了。
    expect(systemTexts[3]).not.toContain(NOTICE_MARK)
  })

  it('提醒只进请求投影，绝不落进持久历史 items', async () => {
    registerFlakyTool('__streak_fail_d__', 'EACCES: 目录不可写')
    seedSession('streak-d', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, systemTexts } = captureSystemTexts([
      () => loadToolCall('__streak_fail_d__', 'load-d'),
      () => toolCallsResponse([{ name: '__streak_fail_d__', args: { attempt: 1 }, id: 'fail-d1' }]),
      () => toolCallsResponse([{ name: '__streak_fail_d__', args: { attempt: 2 }, id: 'fail-d2' }]),
      () => jsonResponse('好'),
    ])

    await runSession('streak-d', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    // 前置条件：提醒确实注入过（否则本用例会假绿）。
    expect(systemTexts[2]).toContain(NOTICE_MARK)
    expect(systemTexts[3]).toContain(NOTICE_MARK)
    const items = getSessionStore('streak-d').store.getter(itemsAtom)
    expect(items.some((it) => it.item.role === 'system')).toBe(false)
    expect(JSON.stringify(items)).not.toContain(NOTICE_MARK)
  })

  it('并发分支（整批只读工具）同样计入失败', async () => {
    registerFlakyTool('__streak_par_a__', 'ENOENT: A 不存在', { parallel: true })
    registerFlakyTool('__streak_par_b__', 'ENOENT: B 不存在', { parallel: true })
    seedSession('streak-par', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, systemTexts } = captureSystemTexts([
      () => loadToolCall('__streak_par_a__', 'load-par-a'),
      () => loadToolCall('__streak_par_b__', 'load-par-b'),
      // 整批都是 parallel 且 >1 → 走并发分支。
      () => toolCallsResponse([
        { name: '__streak_par_a__', args: { attempt: 1 }, id: 'par-a1' },
        { name: '__streak_par_b__', args: { attempt: 1 }, id: 'par-b1' },
      ]),
      () => toolCallsResponse([
        { name: '__streak_par_a__', args: { attempt: 2 }, id: 'par-a2' },
        { name: '__streak_par_b__', args: { attempt: 2 }, id: 'par-b2' },
      ]),
      () => jsonResponse('两个只读工具都失败了'),
    ])

    await runSession('streak-par', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(systemTexts).toHaveLength(5)
    // 第 4 次请求：整批第 1 次失败之后，同一条提醒里把两个工具都列全（count 均为 1）。
    expect(systemTexts[3]).toContain('· __streak_par_a__：调用失败；错误：ENOENT: A 不存在')
    expect(systemTexts[3]).toContain('· __streak_par_b__：调用失败；错误：ENOENT: B 不存在')
    expect(systemTexts[3]).toContain(NOTICE_MARK)
    // 第 5 次请求：两个工具都升到 count=2。
    expect(systemTexts[4]).toContain('· __streak_par_a__：已连续失败 2 次')
    expect(systemTexts[4]).toContain('· __streak_par_b__：已连续失败 2 次')
    expect(systemTexts[4]).toContain(NOTICE_MARK)
  })
})
