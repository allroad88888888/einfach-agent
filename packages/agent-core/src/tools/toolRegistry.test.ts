import { describe, expect, it } from 'vitest'
import { createToolRegistry } from './toolRegistry'
import type { Tool } from './types'

function tool(name: string, description: string, replayUnsafe = false): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description, content: description },
    inputSchema: { type: 'object' },
    replayUnsafe,
    execute: () => ({ ok: true }),
  }
}

function timedTool(overrides: Partial<Tool> = {}): Tool {
  return {
    ...tool('timed', '仅供宿主调度'),
    callTiming: 'turnEnd',
    ...overrides,
  }
}

describe('ToolRegistry dynamic lifecycle', () => {
  it('derives replay safety from the current registration metadata', () => {
    const registry = createToolRegistry()
    registry.register(tool('read_file', 'safe read'))
    registry.register(tool('write_file', 'effectful write', true))

    expect(registry.replayUnsafeToolNames()).toEqual(new Set(['write_file']))

    registry.register(tool('write_file', 'safe replacement'))
    expect(registry.replayUnsafeToolNames()).toEqual(new Set())
  })

  it('从模型发现面剔除到点工具，但按原值保留宿主分派入口', () => {
    const registry = createToolRegistry()
    registry.register(tool('visible', '模型可见'))
    registry.register(timedTool({ callTiming: 'plugin:flush' }))

    expect(registry.list().map((item) => item.name)).toEqual(['visible'])
    expect(registry.loadSchema('timed')).toBeUndefined()
    expect(registry.callTiming('timed')).toBe('plugin:flush')

    const snapshot = registry.snapshot()
    expect(snapshot.list().map((item) => item.name)).toEqual(['visible'])
    expect(snapshot.loadSchema('timed')).toBeUndefined()
  })

  it('外部工具的 callTiming 在注册时剥除并留下诊断', () => {
    const registry = createToolRegistry()
    const external = timedTool({ origin: 'external' })
    registry.register(external)

    expect(registry.list().map((item) => item.name)).toEqual(['timed'])
    expect(registry.loadSchema('timed')?.name).toBe('timed')
    expect(registry.callTiming('timed')).toBeUndefined()
    expect(registry.diagnostics()).toEqual(['外部工具 timed 的 callTiming 已在注册时剥除'])
    expect(registry.has('timed', external)).toBe(true)
    expect(registry.unregister('timed', external)).toBe(true)
  })

  it('snapshot freezes the catalog against later registry mutations', () => {
    const registry = createToolRegistry()
    const removable = tool('dynamic', 'first implementation', true)
    registry.register(removable)
    registry.register(tool('stable', 'stays put'))

    const snapshot = registry.snapshot()

    registry.unregister('dynamic', removable)
    registry.register(tool('late', 'registered after the snapshot'))
    registry.register(tool('stable', 'replaced after the snapshot'))

    expect(snapshot.list().map((item) => item.name)).toEqual(['dynamic', 'stable'])
    expect(snapshot.has('late')).toBe(false)
    expect(snapshot.loadSchema('late')).toBeUndefined()
    // 成员与版本都定在拍照那一刻：被注销的还在，被覆盖的仍是旧版。
    expect(snapshot.loadSchema('dynamic')?.guide).toBe('first implementation')
    expect(snapshot.registrationVersion('dynamic')).toBe(1)
    expect(snapshot.loadSchema('stable')?.guide).toBe('stays put')
    expect(snapshot.registrationVersion('stable')).toBe(1)
    expect(registry.registrationVersion('stable')).toBe(2)
    expect(snapshot.replayUnsafeToolNames()).toEqual(new Set(['dynamic']))
  })

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
