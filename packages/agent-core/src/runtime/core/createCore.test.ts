// 「实例化」第 3 期收口的隔离证明 —— createCore 造出的两套实例互不串台。
// ---------------------------------------------------------------------------
// coreInstance.test.ts 已证明【裸实例】四样（rootStore/sessionStore/tools/abort/config）隔离；
// commands.test.ts 已证明【默认实例】命令编排 + appendItem(iso) 写路径隔离。本文补的是收口那一环：
//   createCore() = 隔离实例 + 绑定它的命令集，故 createCore().sendMessage(...) 就在【自己那套】
//   store/registry/abort/config 上跑 —— 两个 createCore 之间、与 defaultCore 之间，全程不串台。
//
// 手法同 commands.test.ts：mock 掉 modelRun（只验证命令把哪套 core 派给了 runSession/runToolLoop，
//   不真跑 model）+ mock 持久化桥（fire-and-forget，未配置本就 no-op，mock 求个干净）。abort 不 mock，
//   直接 spy 各实例自己的 abort 方法，验证「只动自己那套」。

import { afterEach, describe, expect, it, vi } from 'vitest'

// —— 只验证编排：runSession/runToolLoop 返回 resolved Promise（供 .finally(endRun) 挂载），不真跑 model。——
vi.mock('../modelRun', () => ({
  runSession: vi.fn(() => Promise.resolve()),
  runToolLoop: vi.fn(() => Promise.resolve()),
}))
// 持久化桥全 mock（fire-and-forget；本测不验证落盘）。
vi.mock('../persistenceBridge', () => ({
  persistSessions: vi.fn(),
  persistWorkspaces: vi.fn(),
  persistDeleteSession: vi.fn(),
  persistTruncate: vi.fn(),
}))

import { createCore } from './createCore'
import { defaultCore } from './coreInstance'
import type { Tool } from '../../tools/types'
import { createSubagentScheduler } from '@web-agent/subagents'
import type { DelegationCapability, DelegationRuntimeFactory } from '../delegationContract'
import { configureCommands } from '../commands'
import { runSession, runToolLoop } from '../modelRun'
import { sessionsAtom, activeSessionIdAtom } from '../../state/rootStore'
import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import type { SessionMeta } from '../../state/core.type'

// 让挂在 Promise 上的 .finally 微任务跑完。
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  // 隔离实例随用例 GC；共享 defaultCore 的非 store 配置仍在本文件复原。
  defaultCore.abort.reset()
  Object.assign(defaultCore.config, {
    modelCredentials: {},
    customInstructions: '',
    fetchImpl: undefined,
  })
  vi.clearAllMocks()
})

// 会话元信息样例（固定 id，用于让两套实例登记「同 id」会话来对撞验证不串台）。
function metaOf(id: string): SessionMeta {
  return { id, title: 't', settings: { vendor: 'deepseek', model: 'm' }, createdAt: 0, updatedAt: 0 }
}

// 最小 fake Tool：验证「createCore 能经 registerTools 装工具」这一机制，不牵涉具体标准工具（TS2）。
function makeTool(name: string): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: `${name} 摘要`, content: `# ${name}` },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  }
}

describe('createCore —— 隔离实例 + 绑定命令（第 3 期收口）', () => {
  it('返回 CoreInstance & CommandApi 合体：实例字段 + 命令方法都在同一对象上', () => {
    // 【登记反转 · TS1/TS2】createCore 默认无工具——传 registerTools 注入一个 fake，验证「装了就在」。
    const core = createCore({ registerTools: (r) => r.register(makeTool('probe')) })

    // CoreInstance 那一半。
    expect(typeof core.rootStore.getter).toBe('function')
    expect(typeof core.getSessionStore).toBe('function')
    expect(typeof core.dropSessionStore).toBe('function')
    expect(core.tools.has('probe')).toBe(true)
    expect(typeof core.abort.beginRun).toBe('function')
    expect(core.config).toEqual({
      modelCredentials: {},
      customInstructions: '',
    })

    // CommandApi 那一半（configureCommands 不在其中——它专写 defaultCore）。
    const commandNames = [
      'sendMessage',
      'newWorkspace',
      'selectWorkspace',
      'toggleWorkspaceExpanded',
      'toggleWorkspaceSettings',
      'renameWorkspace',
      'newSession',
      'selectSession',
      'removeSession',
      'stopRun',
      'resumeWithAnswers',
      'confirmTool',
      'approvePlan',
      'answerQuestion',
      'discardArtifact',
      'revertToTurn',
      'revertTurnToDraft',
      'setWorkspaceRoot',
      'renameSession',
      'withdrawCurrentTurnToDraft',
    ] as const
    for (const name of commandNames) {
      expect(typeof core[name]).toBe('function')
    }
  })

  it('两个 createCore 是不同的实例（store/tools/abort 都不是同一个，也都不是 defaultCore 的）', () => {
    const a = createCore()
    const b = createCore()

    expect(a.rootStore).not.toBe(b.rootStore)
    expect(a.rootStore).not.toBe(defaultCore.rootStore)
    expect(a.tools).not.toBe(b.tools)
    expect(a.tools).not.toBe(defaultCore.tools)
    expect(a.abort).not.toBe(b.abort)
    expect(a.abort).not.toBe(defaultCore.abort)
  })

  it('delegation factory 为每个 createCore 装配独立 capability，未注入与 null 都禁用', () => {
    const created = [] as { scheduler: ReturnType<typeof createSubagentScheduler> }[]
    const delegation: DelegationRuntimeFactory = () => {
      const capability: DelegationCapability = {
        scheduler: createSubagentScheduler(),
        async createRuntime() { return { async delegateAgents() { return { treeId: 'fake', conversationId: 'fake', runId: 'fake', parentPath: 'root', strategy: 'parallel_wait_all', status: 'done', summary: { total: 0, done: 0, failed: 0, cancelled: 0 }, cacheBasePath: '.cache', archiveBasePath: '.archive', eventLog: '.archive/events.jsonl', skillFiles: [], skillIds: [], children: [] } } } },
      }
      created.push(capability)
      return capability
    }
    const a = createCore({ delegation })
    const b = createCore({ delegation })
    expect(created).toHaveLength(2)
    expect(a.delegation!.scheduler).toBe(created[0].scheduler)
    expect(b.delegation!.scheduler).toBe(created[1].scheduler)
    expect(a.delegation!.scheduler).not.toBe(b.delegation!.scheduler)
    a.delegation!.scheduler.reserveChildren({
      treeId: 'same-tree-id', sessionId: 'a', parentPath: 'root',
      inheritedSkillFiles: [], inheritedSkillIds: [], children: [{ objective: 'only-a' }],
    })
    b.delegation!.scheduler.reserveChildren({
      treeId: 'same-tree-id', sessionId: 'b', parentPath: 'root',
      inheritedSkillFiles: [], inheritedSkillIds: [], children: [{ objective: 'only-b' }],
    })
    expect(a.delegation!.scheduler.snapshot('same-tree-id').map((node) => node.objective)).toContain('only-a')
    expect(a.delegation!.scheduler.snapshot('same-tree-id').map((node) => node.objective)).not.toContain('only-b')
    expect(b.delegation!.scheduler.snapshot('same-tree-id').map((node) => node.objective)).toContain('only-b')
    expect(b.delegation!.scheduler.snapshot('same-tree-id').map((node) => node.objective)).not.toContain('only-a')
    expect(createCore({ delegation: null }).delegation).toBeUndefined()
    expect(createCore().delegation).toBeUndefined()
  })

  it('透传 projectSkillsProvider 到新建 CoreInstance', async () => {
    const provider = vi.fn(async (workspaceRoot: string) => ({
      workspaceRoot,
      entries: [],
      diagnostics: [],
    }))
    const core = createCore({ projectSkillsProvider: provider })

    await expect(core.projectSkills.ensure('/workspace')).resolves.toMatchObject({
      workspaceRoot: '/workspace',
    })
    expect(provider).toHaveBeenCalledWith('/workspace')
  })

  it('rootStore 隔离：newSession 只登记进自己那套，不进另一个 / 不进 defaultCore', () => {
    const a = createCore()
    const b = createCore()

    const idA = a.newSession({ title: 'A' })
    const idB = b.newSession({ title: 'B' })

    // 各自登记进自己的 rootStore，且成为各自的 active。
    expect(a.rootStore.getter(sessionsAtom)[idA]?.title).toBe('A')
    expect(a.rootStore.getter(activeSessionIdAtom)).toBe(idA)
    expect(b.rootStore.getter(sessionsAtom)[idB]?.title).toBe('B')
    expect(b.rootStore.getter(activeSessionIdAtom)).toBe(idB)

    // 互不串台：a 不含 B、b 不含 A。
    expect(a.rootStore.getter(sessionsAtom)[idB]).toBeUndefined()
    expect(b.rootStore.getter(sessionsAtom)[idA]).toBeUndefined()

    // defaultCore 两个都不含。
    expect(defaultCore.rootStore.getter(sessionsAtom)[idA]).toBeUndefined()
    expect(defaultCore.rootStore.getter(sessionsAtom)[idB]).toBeUndefined()
  })

  it('sendMessage 只在自己那套上跑：读自己 config.apiKey、调自己 abort.beginRun、以自己作 core 传 runSession；另一实例 + defaultCore 的 abort 不被触碰', async () => {
    const a = createCore({ config: { modelCredentials: { deepseek: 'KA' } } })
    const b = createCore({ config: { modelCredentials: { deepseek: 'KB' } } })

    const beginA = vi.spyOn(a.abort, 'beginRun')
    const beginB = vi.spyOn(b.abort, 'beginRun')
    const beginDefault = vi.spyOn(defaultCore.abort, 'beginRun')

    const idA = a.newSession() // deepseek 默认，成为 a 的 active
    a.sendMessage('hi')

    // runSession 被调用一次，core===a、apiKey 取自 a.config（不是 b、不是 defaultCore）。
    expect(runSession).toHaveBeenCalledTimes(1)
    const call = vi.mocked(runSession).mock.calls[0]
    expect(call[0]).toBe(idA)
    expect(call[1]).toBe('hi')
    expect(call[2].core).toBe(a)
    expect(call[2].apiKey).toBe('KA')

    // 只动了 a 自己的 abort。
    expect(beginA).toHaveBeenCalledWith(idA)
    expect(beginB).not.toHaveBeenCalled()
    expect(beginDefault).not.toHaveBeenCalled()

    // b / defaultCore 的会话列表里没有 idA。
    expect(b.rootStore.getter(sessionsAtom)[idA]).toBeUndefined()
    expect(defaultCore.rootStore.getter(sessionsAtom)[idA]).toBeUndefined()

    await flush()
  })

  it('config 隔离：createCore({config}) 各自预置；configureCommands 只改 defaultCore，不碰任一隔离实例', () => {
    const a = createCore({ config: { modelCredentials: { deepseek: 'KA', glm: 'GA' } } })
    const b = createCore({ config: { modelCredentials: { deepseek: 'KB' } } })

    // configureCommands 专写全局默认实例。
    configureCommands({ modelCredentials: { deepseek: 'K-default' } })

    expect(a.config.modelCredentials.deepseek).toBe('KA')
    expect(a.config.modelCredentials.glm).toBe('GA')
    expect(b.config.modelCredentials.deepseek).toBe('KB')
    expect(b.config.modelCredentials.glm).toBeUndefined() // 未预置 → 保持默认空
    expect(defaultCore.config.modelCredentials.deepseek).toBe('K-default')
  })

  // 在给定实例里种一个 waiting_confirmation 会话（同一 id，供两套实例对撞验证）。
  function seedConfirming(core: ReturnType<typeof createCore>, id: string): void {
    core.rootStore.setter(sessionsAtom, (prev) => ({ ...prev, [id]: metaOf(id) }))
    core.rootStore.setter(activeSessionIdAtom, id)
    const store = core.getSessionStore(id).store
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: 'hi' } },
      {
        id: 'a1',
        createdAt: 2,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{}' } }],
        },
      },
    ])
    store.setter(runAtom, {
      runId: 'R1',
      status: 'waiting_confirmation',
      pendingToolConfirmation: { callId: 'w1', toolName: 'write_file', args: { path: 'a.txt', content: 'x' } },
    })
  }

  it('命令写路径隔离：confirmTool(拒绝) 的 error tool result 只落自己会话 store，另一实例 + defaultCore 的同 id 会话为空', () => {
    const a = createCore({ config: { modelCredentials: { deepseek: 'KA' } } })
    const b = createCore({ config: { modelCredentials: { deepseek: 'KB' } } })
    const id = 'shared-sess'

    seedConfirming(a, id)
    // b 也登记同 id 的空会话（还没有任何 items），用来对撞验证「a 的写入不会串到 b」。
    b.rootStore.setter(sessionsAtom, (prev) => ({ ...prev, [id]: metaOf(id) }))

    a.confirmTool(false)

    // a 的会话 store 追加了 error tool result、run 落回 running。
    const aItems = a.getSessionStore(id).store.getter(itemsAtom)
    const last = aItems.at(-1)!.item
    expect(last.role).toBe('tool')
    if (last.role !== 'tool') throw new Error('意外的条目形状')
    expect(last.tool_call_id).toBe('w1')
    expect(JSON.parse(last.content)).toEqual({ error: '用户拒绝执行该工具' })
    expect(a.getSessionStore(id).store.getter(runAtom)?.status).toBe('running')

    // 续跑以 a 自己作 core。
    expect(runToolLoop).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runToolLoop).mock.calls[0][2].core).toBe(a)

    // b 同 id 会话的 items 仍为空（没串台）。
    expect(b.getSessionStore(id).store.getter(itemsAtom)).toEqual([])
    // defaultCore 同 id 会话 items 也为空。
    expect(defaultCore.getSessionStore(id).store.getter(itemsAtom)).toEqual([])
  })

  it('removeSession 隔离：删自己那套的会话，不动另一实例同 id 的会话', () => {
    const a = createCore()
    const b = createCore()
    const id = 'dup-id'

    a.rootStore.setter(sessionsAtom, (prev) => ({ ...prev, [id]: metaOf(id) }))
    b.rootStore.setter(sessionsAtom, (prev) => ({ ...prev, [id]: metaOf(id) }))

    a.removeSession(id)

    // a 删掉了；b 的同 id 会话完好。
    expect(a.rootStore.getter(sessionsAtom)[id]).toBeUndefined()
    expect(b.rootStore.getter(sessionsAtom)[id]?.id).toBe(id)
  })
})
