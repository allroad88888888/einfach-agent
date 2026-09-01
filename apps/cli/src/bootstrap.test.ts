import { describe, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({
  order: [] as string[],
  drain: vi.fn(async () => { probe.order.push('drain') }),
  unsubscribe: vi.fn(() => { probe.order.push('unsubscribe') }),
  assemblyError: undefined as Error | undefined,
}))

vi.mock('./cli-options', () => ({ parseCliOptions: vi.fn(() => ({ help: false, verbose: false, workspaceRoot: '/tmp', configPath: '/tmp/config' })), CLI_USAGE: '' }))
vi.mock('./credentials', () => ({ resolveModelCredentials: vi.fn(async () => ({ modelCredentials: {}, modelBaseUrls: {} })), requireDeepSeekCredential: vi.fn() }))
vi.mock('./workspace-files', () => ({ resolveWorkspaceRoot: vi.fn(async () => '/tmp/workspace') }))
vi.mock('./runtime', () => ({ assembleCliRuntime: vi.fn(async () => {
  if (probe.assemblyError) throw probe.assemblyError
}) }))
vi.mock('./shutdown', () => ({ installCliShutdown: vi.fn(() => ({ registerHostDisposer: vi.fn(), drain: probe.drain })) }))
vi.mock('./event-renderer', () => ({ subscribeCliRenderer: vi.fn(() => probe.unsubscribe) }))
vi.mock('./repl', () => ({ runRepl: vi.fn(async () => undefined), renderWaitingState: vi.fn(), resumeWaitingRun: vi.fn() }))
vi.mock('@einfach-agent/core', () => ({
  defaultCore: { getSessionStore: vi.fn() }, newSession: vi.fn(() => 'session'), setWorkspaceRoot: vi.fn(),
  runAtom: {}, sendMessage: vi.fn(), subscribeAgentEvents: vi.fn(),
}))

describe('CLI bootstrap normal shutdown', () => {
  it('drains after the normal REPL return and renderer unsubscribe', async () => {
    const { main } = await import('./bootstrap')

    await main([])

    expect(probe.unsubscribe).toHaveBeenCalledOnce()
    expect(probe.drain).toHaveBeenCalledOnce()
    expect(probe.order).toEqual(['unsubscribe', 'drain'])
  })

  it('drains an assembly failure without creating a renderer or replacing the primary error', async () => {
    probe.order.length = 0
    probe.unsubscribe.mockClear()
    probe.drain.mockClear()
    probe.assemblyError = new Error('source corruption')
    const { main } = await import('./bootstrap')

    await expect(main([])).rejects.toBe(probe.assemblyError)
    expect(probe.unsubscribe).not.toHaveBeenCalled()
    expect(probe.drain).toHaveBeenCalledOnce()
    probe.assemblyError = undefined
  })

  it('keeps the assembly error as AggregateError cause when drain also fails', async () => {
    const primary = new Error('source corruption')
    const drainFailure = new Error('flush failed')
    probe.assemblyError = primary
    probe.drain.mockRejectedValueOnce(drainFailure)
    const { main } = await import('./bootstrap')

    await expect(main([])).rejects.toMatchObject({ cause: primary, errors: [primary, drainFailure] })
    probe.assemblyError = undefined
  })
})
