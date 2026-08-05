import { describe, expect, it } from 'vitest'

import { userMessageText, type ModelItem, type UserItem } from '@web-agent/ai'
import type { CoreCtx } from './coreCtx'
import type { RequestDraft } from './loopHooks'
import { assemblePlugins, type AgentPlugin } from './pluginApi'

const ctx = { sessionId: 's', runId: 'r' } as unknown as CoreCtx

function user(content: string): UserItem {
  return { role: 'user', content }
}

function draftOf(...contents: string[]): RequestDraft {
  return { messages: contents.map(user) as ModelItem[] }
}

function contentsOf(draft: RequestDraft): string[] {
  return draft.messages.map((m) => userMessageText((m as UserItem).content))
}

describe('onRunStart —— run 启动、首轮请求前，按注册序依次 await', () => {
  it('多个 onRunStart 按注册序生效（含异步：后者等前者跑完）', async () => {
    const order: string[] = []
    const pluginA: AgentPlugin = (api) =>
      api.hook('onRunStart', async () => {
        await Promise.resolve()
        order.push('A')
      })
    const pluginB: AgentPlugin = (api) => api.hook('onRunStart', () => void order.push('B'))

    const hooks = assemblePlugins([pluginA, pluginB])
    await hooks.onRunStart?.(ctx)
    expect(order).toEqual(['A', 'B'])
  })

  it('把调用方传入的 ctx 原样交给每个 hook', async () => {
    const got: CoreCtx[] = []
    const hooks = assemblePlugins([
      (api) => api.hook('onRunStart', (c) => void got.push(c)),
      (api) => api.hook('onRunStart', (c) => void got.push(c)),
    ])
    await hooks.onRunStart?.(ctx)
    expect(got).toEqual([ctx, ctx])
  })

  it('无人注册 onRunStart → 该槽为 undefined（loop 侧据此跳过）', () => {
    const hooks = assemblePlugins([(api) => api.hook('onTurnEnd', () => undefined)])
    expect(hooks.onRunStart).toBeUndefined()
  })
})

describe('transformContext —— 按注册序依次 await，都能改 draft', () => {
  it('多个插件按注册序生效（含异步：后者等前者跑完）', async () => {
    const order: string[] = []
    const pluginA: AgentPlugin = (api) =>
      api.hook('transformContext', async (_c, draft) => {
        await Promise.resolve()
        order.push('A')
        draft.messages.push(user('A'))
      })
    const pluginB: AgentPlugin = (api) =>
      api.hook('transformContext', (_c, draft) => {
        order.push('B')
        draft.messages.push(user('B'))
      })

    const hooks = assemblePlugins([pluginA, pluginB])
    const draft = draftOf()
    await hooks.transformContext?.(ctx, draft)

    expect(order).toEqual(['A', 'B'])
    expect(contentsOf(draft)).toEqual(['A', 'B'])
  })

  it('把调用方传入的 ctx 原样交给每个 hook', async () => {
    const got: CoreCtx[] = []
    const hooks = assemblePlugins([
      (api) => api.hook('transformContext', (c) => void got.push(c)),
      (api) => api.hook('transformContext', (c) => void got.push(c)),
    ])
    await hooks.transformContext?.(ctx, draftOf())
    expect(got).toEqual([ctx, ctx])
  })
})

describe('prepareRequest —— 同 transformContext：按注册序依次 await 改 draft', () => {
  it('两个 prepareRequest 顺序追加', async () => {
    const hooks = assemblePlugins([
      (api) => api.hook('prepareRequest', (_c, d) => void d.messages.push(user('1'))),
      (api) => api.hook('prepareRequest', (_c, d) => void d.messages.push(user('2'))),
    ])
    const draft = draftOf()
    await hooks.prepareRequest?.(ctx, draft)
    expect(contentsOf(draft)).toEqual(['1', '2'])
  })
})
