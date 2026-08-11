// run 工具集 epoch 的单元判据（E1 + E2）。
// ---------------------------------------------------------------------------
// 三层语义各自被钉死：
//   ① 清单固定（E1）—— epoch 建好后 registry 再注册/注销，list/toolNames 都不动；
//   ② 成员内跟随注册版本（E1）—— 同名重注册后 loadSchema/registrationVersion 给的是活着的那一版，
//      注销后回落到 run 开始时的那一份（清单里不消失，但 status 变 retired）；
//   ③ 成员只增不减（E2）—— run 中途新注册的名字虽不进清单，但可加载、可执行（status=live）；
//      注销过的名字仍是成员，status=retired，绝不退化成 absent。
// ④ store：同一个 runId 重入复用同一份 epoch（危险工具确认恢复走的就是这条路）。

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

describe('createToolEpoch —— 清单固定', () => {
  it('run 中途注册的工具不进本 run 的清单', () => {
    const registry = createToolRegistry()
    registry.register(tool('alpha', '旧'))
    const epoch = createToolEpoch(registry, { sessionId: 's', runId: 'r' })

    registry.register(tool('gamma', '新来的'))

    expect(epoch.toolNames).toEqual(['alpha'])
    expect(epoch.list().map((item) => item.name)).toEqual(['alpha'])
    // registry 自己确实变了——固定的只是本 run 【给模型看的那份清单】。
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

  it('replayUnsafe 名单：快照成员按 run 开始时冻结，中途准入的新成员补上', () => {
    const registry = createToolRegistry()
    const writer = tool('writer', '写', { replayUnsafe: true })
    registry.register(writer)
    const epoch = createToolEpoch(registry, { sessionId: 's', runId: 'r' })

    registry.unregister('writer', writer)
    registry.register(tool('late_writer', '中途连上的写工具', { replayUnsafe: true }))

    // 注销的不能忘（压缩仍要给它的历史结果打不可重放标记）；新准入的也不能漏，
    // 否则它执行出来的结果会被误判为可重放。
    expect([...epoch.replayUnsafeToolNames()].sort()).toEqual(['late_writer', 'writer'])
  })
})

describe('createToolEpoch —— 成员只增不减（E2）', () => {
  it('run 中途注册的工具虽不进清单，但可加载、可执行', () => {
    const registry = createToolRegistry()
    registry.register(tool('alpha', '旧'))
    const epoch = createToolEpoch(registry, { sessionId: 's', runId: 'r' })

    registry.register(tool('gamma', '新来的'))

    expect(epoch.status('gamma')).toBe('live')
    expect(epoch.has('gamma')).toBe(true)
    expect(epoch.loadSchema('gamma')?.guide).toBe('新来的')
    expect(epoch.registrationVersion('gamma')).toBe(registry.registrationVersion('gamma'))
    // 「可用」不等于「进清单」：manifest 文本仍是 run 开始时那一份。
    expect(epoch.toolNames).toEqual(['alpha'])
    expect(epoch.list().map((item) => item.name)).toEqual(['alpha'])
  })

  it('中途注册又立刻注销的工具回到 absent，不会被误判成 retired', () => {
    const registry = createToolRegistry()
    const epoch = createToolEpoch(registry, { sessionId: 's', runId: 'r' })
    const late = tool('late', '来了又走')
    registry.register(late)

    expect(epoch.status('late')).toBe('live')

    registry.unregister('late', late)

    // 它从没进过本 run 的清单，模型也没见过它——不该收到「清单里有但掉线了」那套说辞。
    expect(epoch.status('late')).toBe('absent')
    expect(epoch.loadSchema('late')).toBeUndefined()
  })

  it('完全未知的名字仍是 absent', () => {
    const registry = createToolRegistry()
    registry.register(tool('alpha', '旧'))
    const epoch = createToolEpoch(registry, { sessionId: 's', runId: 'r' })

    expect(epoch.status('nobody')).toBe('absent')
    expect(epoch.has('nobody')).toBe(false)
  })

  it('掉线的成员重连后自动回到 live（结构化错误随之消失）', () => {
    const registry = createToolRegistry()
    const alpha = tool('alpha', '第一版')
    registry.register(alpha)
    const epoch = createToolEpoch(registry, { sessionId: 's', runId: 'r' })

    registry.unregister('alpha', alpha)
    expect(epoch.status('alpha')).toBe('retired')

    registry.register(tool('alpha', '重连后的一版'))
    expect(epoch.status('alpha')).toBe('live')
    expect(epoch.loadSchema('alpha')?.guide).toBe('重连后的一版')
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
    expect(resumed.toolNames).toEqual(['alpha'])

    const next = store.ensure('s', 'run-2')
    expect(next).not.toBe(first)
    expect(next.toolNames).toEqual(['alpha', 'gamma'])
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
