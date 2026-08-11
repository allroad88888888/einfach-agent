import { describe, expect, it } from 'vitest'
import { buildPersistedMcpConfig, sanitizePersistedMcpConfig } from './config'
import type { McpAddServerDraft } from './types'

const STDIO_DRAFT: McpAddServerDraft = {
  name: '本地工具',
  transport: 'stdio',
  url: '',
  command: 'npx',
  argsText: '-y\n@example/mcp-server',
  cwd: '',
  autoConnect: false,
}

/**
 * H1: stdio's `autoConnect` used to be hardcoded to `false` in three places
 * (buildPersistedMcpConfig, sanitizePersistedMcpConfig, and service.ts
 * hydrate). This file covers the two config.ts sites: the field must now be
 * an ordinary persistable boolean, round-tripping whatever value was given.
 * Whether a persisted `true` is ever allowed to actually start a local
 * process is a separate, runtime-level decision (service.ts), not something
 * these pure data-shaping functions should decide by silently overwriting
 * the value.
 */
describe('MCP config · stdio autoConnect is a normal persisted field (H1)', () => {
  it('buildPersistedMcpConfig honors a stdio draft with autoConnect: true', () => {
    const config = buildPersistedMcpConfig({ ...STDIO_DRAFT, autoConnect: true }, 'local-1')

    expect(config).toEqual({
      id: 'local-1',
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      autoConnect: true,
    })
  })

  it('buildPersistedMcpConfig still honors a stdio draft with autoConnect: false', () => {
    const config = buildPersistedMcpConfig({ ...STDIO_DRAFT, autoConnect: false }, 'local-2')

    expect(config.autoConnect).toBe(false)
  })

  it('sanitizePersistedMcpConfig reads a stored stdio autoConnect: true back as true', () => {
    const config = sanitizePersistedMcpConfig({
      id: 'local-3',
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      autoConnect: true,
    })

    expect(config?.autoConnect).toBe(true)
  })

  it('sanitizePersistedMcpConfig still defaults a missing or malformed stdio autoConnect to false', () => {
    const missing = sanitizePersistedMcpConfig({
      id: 'local-4',
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
    })
    const malformed = sanitizePersistedMcpConfig({
      id: 'local-5',
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      autoConnect: 'yes',
    })

    expect(missing?.autoConnect).toBe(false)
    expect(malformed?.autoConnect).toBe(false)
  })
})
