import { describe, it, expect } from 'vitest'
import { createCoreInstance, defaultCore } from './coreInstance'
import { sessionsAtom, activeSessionIdAtom } from '../../state/rootAtoms'
import type { Tool } from '../../tools/types'
import type { SessionMeta } from '../../state/core.type'

// 会话元信息样例（DeepSeek 最小合法字面量），用于验证 rootStore 隔离。
const meta: SessionMeta = {
  id: 's1',
  title: 't',
  settings: { vendor: 'deepseek', model: 'x' },
  createdAt: 0,
  updatedAt: 0,
}

// 最小 fake Tool：仅用于验证 tools 注册表隔离（不跑 run，只看 has/list）。
function makeTool(name: string): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: `${name} 摘要`, triggers: [name], content: `# ${name} 指南` },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  }
}

describe('coreInstance —— CoreInstance 抽象与 defaultCore', () => {
  describe('两次 createCoreInstance 得到互相隔离的五类资源', () => {
    it('rootStore 隔离：一个里 setter sessionsAtom 不影响另一个', () => {
      const a = createCoreInstance()
      const b = createCoreInstance()

      expect(a.rootStore).not.toBe(b.rootStore)

      a.rootStore.setter(sessionsAtom, { s1: meta })
      a.rootStore.setter(activeSessionIdAtom, 's1')

      // b 的根 store 完全不受影响（各自独立 createStore）。
      expect(a.rootStore.getter(sessionsAtom)).toEqual({ s1: meta })
      expect(b.rootStore.getter(sessionsAtom)).toEqual({})
      expect(b.rootStore.getter(activeSessionIdAtom)).toBe('')
    })

    it('session store 缓存隔离：同 id 在两个实例里是不同 store；实例内幂等', () => {
      const a = createCoreInstance()
      const b = createCoreInstance()

      const a1 = a.getSessionStore('x')
      const a2 = a.getSessionStore('x')
      const bx = b.getSessionStore('x')

      // 实例内：同 id 幂等（同实例、同 .store）。
      expect(a2).toBe(a1)
      expect(a2.store).toBe(a1.store)
      expect(a1.id).toBe('x')

      // 跨实例：同 id 是彼此独立的 store。
      expect(bx).not.toBe(a1)
      expect(bx.store).not.toBe(a1.store)
    })

    it('session 缓存的 create/drop/reset 只作用于本实例', () => {
      const a = createCoreInstance()
      const b = createCoreInstance()

      const created = a.createSessionStore('y')
      expect(a.getSessionStore('y')).toBe(created)

      // drop 只影响 a：a 重建新实例，b 从未有过该缓存。
      a.dropSessionStore('y')
      expect(a.getSessionStore('y')).not.toBe(created)

      // reset 只清 a。
      const aKeep = a.getSessionStore('z')
      b.getSessionStore('z')
      a.resetSessionStores()
      expect(a.getSessionStore('z')).not.toBe(aKeep)
    })

    it('tools 注册表隔离：往一个注册的工具不出现在另一个', () => {
      // 【登记反转 · TS1/TS2】core 不再硬编码工具——这里用 fake 工具证明「注册表互相隔离」这一 core 机制，
      // 不牵涉具体标准工具（标准工具集完整性由 @web-agent/tools 的 index.test 覆盖）。
      const a = createCoreInstance({ registerTools: (r) => r.register(makeTool('common')) })
      const b = createCoreInstance({ registerTools: (r) => r.register(makeTool('common')) })

      expect(a.tools).not.toBe(b.tools)

      // 各自都装了 'common'（经 registerTools 注入，非 core 硬编码）。
      expect(a.tools.has('common')).toBe(true)
      expect(b.tools.has('common')).toBe(true)

      // 自定义工具只进 a。
      a.tools.register(makeTool('only_in_a'))
      expect(a.tools.has('only_in_a')).toBe(true)
      expect(b.tools.has('only_in_a')).toBe(false)
    })

    it('abort 注册表隔离：一个里 beginRun 不影响另一个的运行态', () => {
      const a = createCoreInstance()
      const b = createCoreInstance()

      const signal = a.abort.beginRun('run1')
      expect(signal.aborted).toBe(false)
      expect(a.abort.isRunning('run1')).toBe(true)
      // b 完全不知道 run1。
      expect(b.abort.isRunning('run1')).toBe(false)

      // 顶掉/清理语义仍在本实例内自洽。
      const signal2 = a.abort.beginRun('run1')
      expect(signal.aborted).toBe(true)
      expect(signal2.aborted).toBe(false)
      a.abort.endRun('run1', signal2)
      expect(a.abort.isRunning('run1')).toBe(false)
    })

    it('subagent 调度器隔离：同一 treeId 的预留节点不会串到另一 CoreInstance', () => {
      const a = createCoreInstance()
      const b = createCoreInstance()

      expect(a.subagentScheduler).not.toBe(b.subagentScheduler)

      a.subagentScheduler.reserveChildren({
        treeId: 'shared-run',
        sessionId: 'session-a',
        parentPath: 'root',
        inheritedSkillFiles: [],
        inheritedSkillIds: [],
        children: [{ objective: 'only-a' }],
      })

      expect(a.subagentScheduler.snapshot('shared-run').map((node) => node.objective)).toEqual([
        'root agent',
        'only-a',
      ])
      expect(b.subagentScheduler.snapshot('shared-run')).toEqual([])
    })
  })

  describe('config', () => {
    it('默认 config 是空 key', () => {
      const core = createCoreInstance()
      expect(core.config).toEqual({
        deepseekApiKey: '',
        glmApiKey: '',
        kimiApiKey: '',
        customInstructions: '',
      })
    })

    it('opts.config 浅合并覆盖默认值，且实例间不共享', () => {
      const a = createCoreInstance({
        config: {
          deepseekApiKey: 'ka',
          deepseekUserId: 'wa_instance_a',
        },
      })
      const b = createCoreInstance({ config: { glmApiKey: 'kb' } })

      expect(a.config.deepseekApiKey).toBe('ka')
      expect(a.config.deepseekUserId).toBe('wa_instance_a')
      expect(a.config.glmApiKey).toBe('')
      expect(b.config.deepseekApiKey).toBe('')
      expect(b.config.deepseekUserId).toBeUndefined()
      expect(b.config.glmApiKey).toBe('kb')
    })
  })

  describe('defaultCore', () => {
    it('是一个可用的 CoreInstance：根 store + 注册表就位（标准工具由 harness 装入）', () => {
      // 根 store 支持 getter/setter（读默认值不污染全局）。
      expect(typeof defaultCore.rootStore.getter).toBe('function')

      // 【登记反转 · TS1/TS2】defaultCore 造出来无工具；测试环境由 test/setup.ts 全局
      // registerStandardTools(toolRegistry) 装齐（标准工具集内容由 @web-agent/tools 的 index.test 覆盖）。
      // 这里只验证 defaultCore.tools 是一个可用注册表（不点名任何具体标准工具，保持 core 对工具无知）。
      expect(defaultCore.tools.list().length).toBeGreaterThan(0)
      expect(typeof defaultCore.tools.register).toBe('function')
      expect(typeof defaultCore.tools.loadSchema).toBe('function')

      // abort 注册表方法齐备。
      expect(typeof defaultCore.abort.beginRun).toBe('function')
      expect(typeof defaultCore.abort.reset).toBe('function')
    })
  })
})
