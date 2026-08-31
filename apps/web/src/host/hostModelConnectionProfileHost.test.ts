import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedHost } from './resolveHost'

const mocks = vi.hoisted(() => ({
  server: { available: true },
  unavailable: { available: false },
  createServer: vi.fn(),
  createUnavailable: vi.fn(),
}))

vi.mock('../settings/serverModelConnectionProfileHost', () => ({
  createServerModelConnectionProfileHost: mocks.createServer,
}))
vi.mock('../settings/modelConnectionProfileHost', () => ({
  createUnavailableModelConnectionProfileHost: mocks.createUnavailable,
}))

const { createHostModelConnectionProfileHost } = await import('./hostModelConnectionProfileHost')

describe('createHostModelConnectionProfileHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createServer.mockReturnValue(mocks.server)
    mocks.createUnavailable.mockReturnValue(mocks.unavailable)
  })

  it('selects server CRUD only for a server host', () => {
    const host: ResolvedHost = { kind: 'server', platform: 'linux' }
    expect(createHostModelConnectionProfileHost(host)).toBe(mocks.server)
    expect(mocks.createServer).toHaveBeenCalledOnce()
    expect(mocks.createUnavailable).not.toHaveBeenCalled()
  })

  it('keeps static deployments unavailable', () => {
    const host: ResolvedHost = { kind: 'static', reason: 'unreachable' }
    expect(createHostModelConnectionProfileHost(host)).toBe(mocks.unavailable)
    expect(mocks.createUnavailable).toHaveBeenCalledOnce()
    expect(mocks.createServer).not.toHaveBeenCalled()
  })
})
