import { describe, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({
  hydrate: vi.fn(async () => false),
  newSession: vi.fn(),
  render: vi.fn(),
  reconcile: vi.fn(async () => ({ histories: [{ historyId: 'bad', recordsApplied: 0, nextByteOffset: 0,
    warning: { kind: 'source', code: 'CORRUPT', message: 'unterminated JSONL' } }] })),
}))

vi.mock('./host/resolveHost', () => ({ resolveHost: vi.fn(async () => ({ kind: 'server', platform: 'linux' })) }))
vi.mock('./persistence/persistenceDrivers', () => ({ createHostPersistenceDrivers: vi.fn(async () => ({
  agentRollout: { reconcile: probe.reconcile, append: vi.fn(), flush: vi.fn() },
})) }))
vi.mock('react-dom/client', () => ({ createRoot: vi.fn(() => ({ render: probe.render })) }))
vi.mock('./mcp/initialize', () => ({ initializeMcpSettings: vi.fn() }))
vi.mock('./mcp/commands', () => ({ hydrateMcpSettings: vi.fn(async () => undefined) }))
vi.mock('./plugins/initialize', () => ({ initializePluginSettings: vi.fn() }))
vi.mock('./plugins/commands', () => ({ hydratePluginSettings: vi.fn(async () => undefined) }))
vi.mock('./persistence/recoveryFlushLifecycle', () => ({ installBrowserRecoveryFlush: vi.fn() }))
vi.mock('@einfach-agent/core/runtime/commands', () => ({ configureCommands: vi.fn(), newSession: probe.newSession }))
vi.mock('@einfach-agent/core/observability/trace', () => ({ configureObservability: vi.fn() }))
vi.mock('@einfach-agent/observability-idb', () => ({ createIndexedDbLogDriver: vi.fn(() => ({})), createIndexedDbLogReader: vi.fn(() => ({})) }))
vi.mock('./agentNew/ui/AppShell', () => ({ AppShell: () => null }))
vi.mock('./agentNew/ui/StartupCredentialGate', () => ({ StartupCredentialGate: () => null }))
vi.mock('./agentNew/ui/WebTimelineRendererRegistryProvider', () => ({ WebTimelineRendererRegistryProvider: () => null }))
vi.mock('./settings/commands', () => ({ configureModelCredentialHost: vi.fn(), configureModelEndpointHost: vi.fn(), hydrateAppSettings: vi.fn(async () => undefined), hydrateModelEndpoint: vi.fn(async () => undefined) }))
vi.mock('./settings/modelConnectionProfileCommands', () => ({ configureModelConnectionProfileHost: vi.fn(), hydrateModelConnectionProfiles: vi.fn(async () => undefined) }))
vi.mock('./settings/modelCredentialHost', () => ({ MODEL_CREDENTIALS: [] }))
vi.mock('./settings/startupCredentialTarget', () => ({ resolveStartupCredentialTarget: vi.fn() }))
vi.mock('./modelInput/prepareProviderUserInput', () => ({ prepareProviderUserInput: vi.fn() }))
vi.mock('./modelInput/disposeProviderUserContent', () => ({ disposeProviderUserContent: vi.fn() }))
vi.mock('./performanceDiagnostics', () => ({ reportReactCommit: vi.fn(), startUiPerformanceDiagnostics: vi.fn() }))

describe('main entry · server rollout source corruption', () => {
  it('rejects before hydration, new session, or rendering can make an agent executable', async () => {
    document.body.innerHTML = '<div id="root"></div>'
    const { defaultCore } = await import('@einfach-agent/core')
    const hydrate = vi.spyOn(defaultCore.persistence, 'hydrate').mockImplementation(probe.hydrate)

    const { started } = await import('./main')

    await expect(started).rejects.toThrow('unterminated JSONL')
    expect(probe.reconcile).toHaveBeenCalledOnce()
    expect(hydrate).not.toHaveBeenCalled()
    expect(probe.newSession).not.toHaveBeenCalled()
    expect(probe.render).not.toHaveBeenCalled()
  })
})
