import { createToolRegistry } from '@einfach-agent/core/tools'
import { describe, expect, it, vi } from 'vitest'
import { createNetworkTools, registerNetworkTools } from './index'

describe('network tool registration', () => {
  it('registers all factories in the real registry', () => {
    const host = {
      startCapture: vi.fn(), stopCapture: vi.fn(), listRequests: vi.fn(),
      getRequest: vi.fn(), getResponse: vi.fn(), waitForRequest: vi.fn(),
    }
    const registry = createToolRegistry()
    registerNetworkTools(registry, host)
    expect(registry.list().map((tool) => tool.name)).toEqual(createNetworkTools(host).map((tool) => tool.name))
  })
})
