import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { configureHostInvoke, defaultCore } from '@einfach-agent/core'
import { loadHostInvoke } from '@einfach-agent/core/runtime/hostBridge'
import { closeSqliteConnections } from '@einfach-agent/host-node'
import { assembleCliRuntime } from './runtime'
import { installCliShutdown } from './shutdown'

describe.skipIf(process.platform === 'win32')('CLI services shutdown wiring', () => {
  it('the assembled in-process bridge registers services with the normal drain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cli-services-'))
    const shutdown = installCliShutdown({ target: { on() {}, exit() {} }, notice() {} })
    let runtime: Awaited<ReturnType<typeof assembleCliRuntime>> | undefined
    try {
      runtime = await assembleCliRuntime({
        credentials: { modelCredentials: {}, modelBaseUrls: {}, configPath: '/dev/null' }, verbose: false,
        workspaceRoot: root, databasePath: join(root, 'state.db'), registerHostDisposer: shutdown.registerHostDisposer,
      })
      const invoke = await loadHostInvoke()
      const service = await invoke<{ serviceId: string }>('start_session_service', { sessionId: 'cli', command: `${JSON.stringify(process.execPath)} -e 'setInterval(()=>{},1000)'` })
      expect(await invoke('get_session_service', { sessionId: 'cli', serviceId: service.serviceId })).toMatchObject({ state: 'running' })
      await shutdown.drain()
      await expect(invoke('get_session_service', { sessionId: 'cli', serviceId: service.serviceId })).rejects.toThrow('Unknown service')
      await expect(invoke('start_session_service', { sessionId: 'other', command: 'true' })).rejects.toThrow('closed')
    } finally {
      await shutdown.drain(); await runtime?.flush(); configureHostInvoke(undefined)
      defaultCore.persistence.reset(); await closeSqliteConnections(); await rm(root, { recursive: true, force: true })
    }
  })
})
