// 占位同步器的第二组判据：写 ToolRegistry 的纪律。
//
// 三条不可推翻：真实工具永远优先（占位从不覆盖任何已存在的注册）、注销一律 expected 形式
// （真实工具接管过这个名字就绝不可能被误伤）、跨服务撞名先到先得且留痕不静默。
// desired 规则与四个重算时机在 placeholderSync.test.ts。

import { createToolRegistry } from '@web-agent/core/tools'
import { describe, expect, it } from 'vitest'
import { createMcpPlaceholderClaims } from './placeholderClaims'
import { createMcpPlaceholderSync, type McpPlaceholderSkip } from './placeholderSync'
import {
  fakeManager,
  fakeTool,
  lastKnown,
  setupPlaceholderSync,
  snapshot,
} from './placeholderSync.fixtures'

describe('占位从不覆盖已存在的注册', () => {
  it('名字已被真实工具占着：跳过，绝不覆盖', () => {
    const registry = createToolRegistry()
    const real = fakeTool('mcp__docs__search')
    registry.register(real)
    const claims = createMcpPlaceholderClaims()
    const fake = fakeManager(snapshot('docs', 'disconnected'))

    createMcpPlaceholderSync({
      registry,
      manager: fake.manager,
      claims,
      lastKnownTools: () => lastKnown('docs', ['mcp__docs__search', 'mcp__docs__draft']),
    })

    expect(registry.has('mcp__docs__search', real)).toBe(true)
    expect(claims.get('mcp__docs__search')).toBeUndefined()
    // 没被占的那个照常登记：撞名只影响撞上的那一个。
    expect(claims.namesFor('docs')).toEqual(['mcp__docs__draft'])
  })

  it('跨服务撞名先到先得：后者跳过，并且留痕不静默', () => {
    const skips: McpPlaceholderSkip[] = []
    const shared = 'mcp__shared__tool'
    const wired = setupPlaceholderSync({
      servers: [snapshot('alpha', 'disconnected'), snapshot('beta', 'disconnected')],
      cache: { alpha: lastKnown('alpha', [shared]), beta: lastKnown('beta', [shared]) },
      onSkip: (skip) => skips.push(skip),
    })

    expect(wired.claims.get(shared)?.serverId).toBe('alpha')
    expect(wired.claims.namesFor('beta')).toEqual([])
    expect(skips).toEqual([{ serverId: 'beta', name: shared, reason: 'name_taken' }])
  })
})

describe('注销与登记成对，且一律 expected 形式', () => {
  it('真实工具接管了这个名字就绝不会被误伤', () => {
    const wired = setupPlaceholderSync()
    const placeholder = wired.claims.get('mcp__docs__search')?.tool
    expect(placeholder).toBeDefined()

    // 模拟 reconcile：真实工具原地覆盖同名占位，并释放占位登记。
    const real = fakeTool('mcp__docs__search')
    wired.registry.register(real)
    wired.claims.release('mcp__docs__search', placeholder)

    // 此后服务连上，同步器要清掉这个服务名下的占位。
    wired.setStatus('docs', 'connected')

    // 真实工具原封不动地留在 registry 里，另一个占位则被正常注销。
    expect(wired.registry.has('mcp__docs__search', real)).toBe(true)
    expect(wired.registry.has('mcp__docs__draft')).toBe(false)
  })

  it('每一个注册都有一条对应的登记，注销后两边同时消失', () => {
    const wired = setupPlaceholderSync()

    for (const name of wired.claims.namesFor('docs')) {
      expect(wired.registry.has(name, wired.claims.get(name)?.tool)).toBe(true)
    }

    wired.remove('docs')

    expect(wired.names()).toEqual([])
    expect(wired.claims.namesFor('docs')).toEqual([])
  })
})

describe('无谓的重算不产生注册', () => {
  it('形状没变就一次注册都不发生：manifest 不因为一次空转而抖动', () => {
    const wired = setupPlaceholderSync()
    const version = wired.registry.registrationVersion('mcp__docs__search')

    wired.sync.sync()
    wired.sync.sync()

    expect(wired.registry.registrationVersion('mcp__docs__search')).toBe(version)
  })

  it('缓存描述变了就换一份占位：manifest 那一行跟着更新', () => {
    const wired = setupPlaceholderSync()
    const before = wired.description('mcp__docs__search')

    wired.setCache({
      docs: {
        ...lastKnown('docs', ['mcp__docs__search']),
        tools: [{ name: 'mcp__docs__search', description: '换了一句新的描述' }],
      },
    })
    wired.sync.sync()

    expect(wired.description('mcp__docs__search')).not.toBe(before)
    expect(wired.description('mcp__docs__search')).toBe('换了一句新的描述')
  })
})
