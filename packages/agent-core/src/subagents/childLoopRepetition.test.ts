// 子 run 撞 maxTurns 时「说得出在重复什么」的判据复用与收尾文案。
// ---------------------------------------------------------------------------
// 覆盖：
//   · 判据复用：达阈值(3)前不出结论、达阈值后给出工具名 + 重复轮数 + 参数（用的是主 run
//     loopGuardPlugin 那份签名规范化 + 计数，见 runtime/shared/toolRepetition）。
//   · 与主 run 的刻意差异：子 run 【不清零】—— 模型边写正文边反复调同一个工具照样被数出来
//     （主 run 在有正文的轮次会 clear，因为那条路要终止 run，判据必须保守）。
//   · 信息落点：结论进的是 ChildAgentResult.summary —— 父 agent 经 join_agent / observe_agent
//     真正读到的那一层，不是只塞进抛出的异常串。
//   · 提前收敛（没撞上限）的子 run 收尾文案一字不加。
//
// 变异自检（手动验证过会红）：
//   · childAgentLoop 里 `isSynthesisTurn ? childExhaustionSummary(...)` 改成恒不加 → e2e 断言全红。
//   · createChildRepetitionWatch 换成每轮新建 tracker → 计数永远到不了 3，e2e 断言红。

import { describe, expect, it, vi } from 'vitest'
import type { ModelToolCall } from '@einfach-agent/ai'
import {
  childExhaustionSummary,
  childMaxTurnsError,
  createChildRepetitionWatch,
} from './childLoopRepetition'
import {
  context,
  messagesOf,
  namedToolCall,
  requestBody,
  response,
  runtime,
} from './runtime.testHarness'

function call(name: string, args: Record<string, unknown>, id = 'c1'): ModelToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

describe('createChildRepetitionWatch —— 复用主 run 的重复判据', () => {
  it('同一工具同一参数累计到阈值(3)才出结论，前两轮沉默', () => {
    const watch = createChildRepetitionWatch()
    watch.observeTurn([call('read_file', { path: 'a.ts' })])
    expect(watch.repeated()).toBeUndefined()
    watch.observeTurn([call('read_file', { path: 'a.ts' })])
    expect(watch.repeated()).toBeUndefined()
    watch.observeTurn([call('read_file', { path: 'a.ts' })])
    expect(watch.repeated()).toMatchObject({ toolName: 'read_file', repeatedCount: 3 })
  })

  it('键序不同的同一份参数算同一次重复（签名规范化来自共享判据）', () => {
    const watch = createChildRepetitionWatch()
    watch.observeTurn([call('grep', { a: 1, b: 2 })])
    watch.observeTurn([call('grep', { b: 2, a: 1 })])
    watch.observeTurn([call('grep', { a: 1, b: 2 })])
    expect(watch.repeated()?.repeatedCount).toBe(3)
  })

  it('参数不同就不是打转：三轮各不相同 → 无结论', () => {
    const watch = createChildRepetitionWatch()
    for (const path of ['a.ts', 'b.ts', 'c.ts']) watch.observeTurn([call('read_file', { path })])
    expect(watch.repeated()).toBeUndefined()
  })

  it('重复轮数一路刷新到最终值（不停在首次命中的 3）', () => {
    const watch = createChildRepetitionWatch()
    for (let i = 0; i < 5; i += 1) watch.observeTurn([call('read_file', { path: 'a.ts' })])
    expect(watch.repeated()?.repeatedCount).toBe(5)
  })

  it('同一轮里发三个相同调用只算一轮（并发批量不等于打转）', () => {
    const watch = createChildRepetitionWatch()
    watch.observeTurn([
      call('read_file', { path: 'a.ts' }, 'x'),
      call('read_file', { path: 'a.ts' }, 'y'),
      call('read_file', { path: 'a.ts' }, 'z'),
    ])
    expect(watch.repeated()).toBeUndefined()
  })
})

describe('收尾文案', () => {
  const looping = () => {
    const watch = createChildRepetitionWatch()
    for (let i = 0; i < 3; i += 1) watch.observeTurn([call('read_file', { path: 'src/a.ts' })])
    return watch
  }

  it('有重复：结论后接上工具名、重复轮数与参数', () => {
    const summary = childExhaustionSummary('没查出结果。', looping(), 4)
    expect(summary).toContain('没查出结果。')
    expect(summary).toContain('【疑似死循环】')
    expect(summary).toContain('read_file')
    expect(summary).toContain('3 轮')
    expect(summary).toContain('{"path":"src/a.ts"}')
  })

  it('无重复：收尾文案一字不加', () => {
    const watch = createChildRepetitionWatch()
    watch.observeTurn([call('read_file', { path: 'a.ts' })])
    expect(childExhaustionSummary('结论。', watch, 4)).toBe('结论。')
  })

  it('超长参数被截断，不把整份参数灌给父 agent', () => {
    const watch = createChildRepetitionWatch()
    const args = { query: 'x'.repeat(500) }
    for (let i = 0; i < 3; i += 1) watch.observeTurn([call('grep', args)])
    const summary = childExhaustionSummary('结论。', watch, 4)
    expect(summary).toContain('…')
    expect(summary.length).toBeLessThan(400)
  })

  it('抛错路径保留可检索的英文标识，并带上重复原因', () => {
    const message = childMaxTurnsError(looping(), 4).message
    expect(message).toContain('child agent exceeded maxTurns 4')
    expect(message).toContain('子 agent 用尽 4 轮上限')
    expect(message).toContain('read_file')
    expect(message).toContain('3 轮')
  })
})

describe('子 run 撞 maxTurns（端到端）', () => {
  // 每轮都带正文 + 同一个 read_file：主 run 的 loopGuard 会因为「有正文」清零而看不见，
  // 子 run 必须照样数出来 —— 它不终止任何东西，只解释一次已经发生的 maxTurns 收尾。
  function loopingTurn(id: string): Response {
    return response({
      role: 'assistant',
      content: '我再确认一下这个文件。',
      tool_calls: [{
        id,
        type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/a.ts' }) },
      }],
    })
  }

  function isSynthesisRequest(body: Record<string, unknown>): boolean {
    return messagesOf(body).some((message) => message.content?.includes('工具调查到此结束'))
  }

  it('报告里说得出重复的工具名与重复轮数，且它出现在父 agent 读到的 summary 上', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'same body' } }))
    let turns = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (isSynthesisRequest(body)) return response({ content: '仍未定位到问题。' })
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      turns += 1
      return loopingTurn(`loop-${turns}`)
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'find the bug' }], toolProfile: 'workspace_read' },
      callContext,
    )

    const child = result.children[0]
    expect(child.status).toBe('done')
    // 强制合成轮的结论还在，原因接在它后面。
    expect(child.summary).toContain('仍未定位到问题。')
    expect(child.summary).toContain('【疑似死循环】')
    expect(child.summary).toContain('read_file')
    expect(child.summary).toContain('3 轮')
    expect(child.summary).toContain('{"path":"src/a.ts"}')
    delegateRuntime.dispose?.()
  })

  it('每轮换参数的子 run 撞上限时不加任何说明', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'body' } }))
    let turns = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (isSynthesisRequest(body)) return response({ content: '查完了。' })
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      turns += 1
      return namedToolCall(`step-${turns}`, 'read_file', { path: `src/${turns}.ts` })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'survey' }], toolProfile: 'workspace_read' },
      callContext,
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: '查完了。' })
    delegateRuntime.dispose?.()
  })

  it('合成轮里模型仍在调工具时，failed 的 summary/error 也带上重复原因', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'same body' } }))
    let turns = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!isSynthesisRequest(body) && body.tool_choice === 'none') {
        return response({ content: '# skill' })
      }
      turns += 1
      return loopingTurn(`loop-${turns}`)
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'never converge' }], toolProfile: 'workspace_read' },
      callContext,
    )

    const child = result.children[0]
    expect(child.status).toBe('failed')
    expect(child.error).toContain('child agent exceeded maxTurns 4')
    expect(child.summary).toContain('【疑似死循环】')
    expect(child.summary).toContain('read_file')
    delegateRuntime.dispose?.()
  })
})
