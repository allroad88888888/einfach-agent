// run 工具集 epoch 的单元判据（E1）。
// ---------------------------------------------------------------------------
// 两层语义各自被钉死：
//   ① 成员固定 —— epoch 建好后 registry 再注册/注销，list/has/toolNames 都不动；
//   ② 成员内跟随注册版本 —— 同名重注册后 loadSchema/registrationVersion 给的是活着的那一版，
//      注销后回落到 run 开始时的那一份（清单里不消失，但 status 变 retired）。
// ③ store：同一个 runId 重入复用同一份 epoch（危险工具确认恢复走的就是这条路）。

import { describe, expect, it } from 'vitest'
import { createToolRegistry } from '../tools/toolRegistry'
import type { Tool } from '../tools/types'
import { createToolEpoch } from './toolEpoch'
import { createToolEpochStore } from './toolEpochStore'

function tool(name: string, guide: string, options: { replayUnsafe?: boolean } = {}): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: `${name} 摘要`, content: guide },
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    ...(options.replayUnsafe ? { replayUnsafe: true as const } : {}),
    execute: () => ({ ok: true as const }),
  }
}

describe('createToolEpoch —— 成员固定', () => {
  it('run 中途注册的工具不进本 run 的清单', () => {
    const registry = createToolRegistry()
    registry.register(tool('alpha', '旧'))
    const epoch = createToolEpoch(registry, { sessionId: 's', runId: 'r' })

    registry.register(tool('gamma', '新来的'))

    expect(epoch.toolNames).toEqual(['alpha'])
    expect(epoch.list().map((item) => item.name)).toEqual(['alpha'])
    expect(epoch.has('gamma')).toBe(false)
    expect(epoch.loadSchema('gamma')).toBeUndefined()
    expect(epoch.registrationVersion('gamma')).toBeUndefined()
    expect(epoch.status('gamma')).toBe('absent')
    // registry 自己确实变了——固定的只是本 run 的视图。
    expect(registry.has('gamma')).toBe(true)
  })

  it('run 中途注销的工具仍留在清单里，并保留 run 开始时的 schema', () => {
    const registry = createToolRegistry()
    const alpha = tool('alpha', '本 run 开始时的指南')
    registry.register(alpha)
    const epoch = createToolEpoch(registry, { sessionId: 's', runId: 'r' })
    const versionAtStart = epoch.registrationVersion('alpha')

    registry.unregister('alpha', alpha)

    expect(epoch.toolNames).toEqual(['alpha'])
    expect(epoch.list().map((item) => item.name)).toEqual(['alpha'])
    expect(epoch.loadSchema('alpha')?.guide).toBe('本 run 开始时的指南')
    expect(epoch.registrationVersion('alpha')).toBe(versionAtStart)
    expect(epoch.status('alpha')).toBe('retired')
    expect(registry.loadSchema('alpha')).toBeUndefined()
  })

  it('replayUnsafe 名单同样按 run 开始时冻结', () => {
    const registry = createToolRegistry()
    const writer = tool('writer', '写', { replayUnsafe: true })
    registry.register(writer)
    const epoch = createToolEpoch(registry, { sessionId: 's', runId: 'r' })

    registry.unregister('writer', writer)

    expect([...epoch.replayUnsafeToolNames()]).toEqual(['writer'])
  })
})

describe('createToolEpoch —— 成员内跟随注册版本', () => {
  it('同名重注册后给出活着的那一版，自愈路径不被冻住', () => {
    const registry = createToolRegistry()
    registry.register(tool('alpha', '旧实现'))
    const epoch = createToolEpoch(registry, { sessionId: 's', runId: 'r' })
    const oldVersion = epoch.registrationVersion('alpha')

    registry.register(tool('alpha', '重连后的新实现'))

    expect(epoch.registrationVersion('alpha')).toBe(registry.registrationVersion('alpha'))
    expect(epoch.registrationVersion('alpha')).not.toBe(oldVersion)
    expect(epoch.loadSchema('alpha')?.guide).toBe('重连后的新实现')
    expect(epoch.status('alpha')).toBe('live')
  })
})

describe('createToolEpochStore', () => {
  it('同一个 runId 重入复用同一份 epoch，换 runId 才重新冻结', () => {
    const registry = createToolRegistry()
    registry.register(tool('alpha', '旧'))
    const store = createToolEpochStore(registry)

    const first = store.ensure('s', 'run-1')
    registry.register(tool('gamma', '暂停期间连上的 MCP 工具'))
    const resumed = store.ensure('s', 'run-1')

    expect(resumed).toBe(first)
    expect(resumed.has('gamma')).toBe(false)

    const next = store.ensure('s', 'run-2')
    expect(next).not.toBe(first)
    expect(next.has('gamma')).toBe(true)
  })

  it('get 只认精确的 (sessionId, runId)，release/reset 之后拿不到', () => {
    const registry = createToolRegistry()
    const store = createToolEpochStore(registry)
    const epoch = store.ensure('s', 'run-1')

    expect(store.get('s', 'run-1')).toBe(epoch)
    expect(store.get('s', 'run-2')).toBeUndefined()
    expect(store.get('other', 'run-1')).toBeUndefined()

    store.release('s')
    expect(store.get('s', 'run-1')).toBeUndefined()

    store.ensure('s', 'run-3')
    store.reset()
    expect(store.get('s', 'run-3')).toBeUndefined()
  })

  it('每个 CoreInstance 的 epoch 互不可见（registry 各自绑定）', () => {
    const left = createToolRegistry()
    const right = createToolRegistry()
    left.register(tool('alpha', '左'))
    right.register(tool('beta', '右'))

    expect(createToolEpochStore(left).ensure('s', 'r').toolNames).toEqual(['alpha'])
    expect(createToolEpochStore(right).ensure('s', 'r').toolNames).toEqual(['beta'])
  })
})
