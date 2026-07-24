import { describe, expect, it } from 'vitest'
import { createToolRegistry } from './toolRegistry'
import type { Tool } from './types'

function tool(name: string, description: string): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description, content: description },
    inputSchema: { type: 'object' },
    execute: () => ({ ok: true }),
  }
}

describe('ToolRegistry dynamic lifecycle', () => {
  it('unregister removes a tool from every registry view', async () => {
    const registry = createToolRegistry()
    const registered = tool('dynamic', 'remote tool')
    registry.register(registered)
    const registrationVersion = registry.registrationVersion('dynamic')
    expect(registrationVersion).toBe(1)
    expect(registry.loadSchema('dynamic')?.registrationVersion).toBe(registrationVersion)

    expect(registry.unregister('dynamic')).toBe(true)
    expect(registry.has('dynamic')).toBe(false)
    expect(registry.registrationVersion('dynamic')).toBeUndefined()
    expect(registry.list()).toEqual([])
    expect(registry.loadSchema('dynamic')).toBeUndefined()
    expect(registry.execution('dynamic')).toBeUndefined()
    await expect(
      registry.run('dynamic', {}, {
        sessionId: 'test',
        signal: new AbortController().signal,
      } as never),
    ).resolves.toEqual({ ok: false, error: 'unknown tool: dynamic' })
  })

  it('only unregisters the expected instance when a name was replaced', () => {
    const registry = createToolRegistry()
    const stale = tool('dynamic', 'stale')
    const current = tool('dynamic', 'current')
    registry.register(stale)
    const staleVersion = registry.registrationVersion('dynamic')
    registry.register(current)
    const currentVersion = registry.registrationVersion('dynamic')

    expect(staleVersion).toBe(1)
    expect(currentVersion).toBe(2)
    expect(currentVersion).toBeGreaterThan(staleVersion!)
    expect(registry.has('dynamic', stale)).toBe(false)
    expect(registry.has('dynamic', current)).toBe(true)
    expect(registry.unregister('dynamic', stale)).toBe(false)
    expect(registry.loadSchema('dynamic')?.description).toBe('current')
    expect(registry.loadSchema('dynamic')?.registrationVersion).toBe(currentVersion)
    expect(registry.unregister('dynamic', current)).toBe(true)
  })

  it('does not reuse or expose a deleted registration version when the same instance is re-registered', () => {
    const registry = createToolRegistry()
    const reused = tool('dynamic', 'same instance')
    registry.register(reused)
    const staleSnapshot = registry.loadSchema('dynamic')
    expect(staleSnapshot?.registrationVersion).toBe(1)

    expect(registry.unregister('dynamic', reused)).toBe(true)
    expect(registry.registrationVersion('dynamic')).toBeUndefined()
    expect(registry.registrationVersion('dynamic')).not.toBe(staleSnapshot?.registrationVersion)

    registry.register(reused)
    const currentSnapshot = registry.loadSchema('dynamic')
    expect(currentSnapshot?.registrationVersion).toBe(2)
    expect(currentSnapshot?.registrationVersion).not.toBe(staleSnapshot?.registrationVersion)
    expect(registry.registrationVersion('dynamic')).toBe(currentSnapshot?.registrationVersion)
  })

  it('fails closed before executing a same-name replacement when the expected version is stale', async () => {
    const registry = createToolRegistry()
    let staleExecutions = 0
    let currentExecutions = 0
    const stale: Tool = {
      ...tool('dynamic', 'stale'),
      execute: () => {
        staleExecutions += 1
        return { ok: true }
      },
    }
    const current: Tool = {
      ...tool('dynamic', 'current'),
      execute: () => {
        currentExecutions += 1
        return { ok: true }
      },
    }
    const context = {
      sessionId: 'test',
      signal: new AbortController().signal,
    } as never

    registry.register(stale)
    const staleVersion = registry.loadSchema('dynamic')?.registrationVersion
    registry.register(current)
    const currentVersion = registry.loadSchema('dynamic')?.registrationVersion

    await expect(registry.run('dynamic', {}, context, staleVersion)).resolves.toEqual({
      ok: false,
      error: 'tool registration version mismatch: dynamic (expected 1, current 2)',
    })
    expect(staleExecutions).toBe(0)
    expect(currentExecutions).toBe(0)

    await expect(registry.run('dynamic', {}, context, currentVersion)).resolves.toEqual({ ok: true })
    expect(currentExecutions).toBe(1)

    // 旧调用方不传版本时保持原有行为，执行当前注册实例。
    await expect(registry.run('dynamic', {}, context)).resolves.toEqual({ ok: true })
    expect(staleExecutions).toBe(0)
    expect(currentExecutions).toBe(2)
  })

  it('returns false for an unknown tool', () => {
    const registry = createToolRegistry()
    expect(registry.unregister('missing')).toBe(false)
    expect(registry.registrationVersion('missing')).toBeUndefined()
  })
})
