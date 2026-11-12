import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createToolRegistry } from '@einfach-agent/core/tools'
import { registerShellTools } from '../index'
import { serviceTools } from './tools'

describe('session service tool contract', () => {
  it('discovers four server tools with no model-supplied owner', () => {
    const registry = createToolRegistry(); registerShellTools(registry)
    for (const tool of serviceTools) {
      expect(registry.has(tool.name)).toBe(true)
      expect(tool.runtime).toBe('server')
      expect(JSON.stringify(tool.inputSchema)).not.toContain('sessionId')
    }
  })
  it('rejects direct file writes before invoking start capability', async () => {
    const sessionService = vi.fn()
    const result = await serviceTools[0].execute({ command: 'echo secret > file.txt' }, { sessionService } as unknown as ToolContext)
    expect(result).toMatchObject({ ok: false, code: 'shell_file_write_rejected' })
    expect(sessionService).not.toHaveBeenCalled()
  })
  it.each(['Service capacity reached', 'Service session is closed', 'Unknown service', 'Session services are unsupported on Windows'])('preserves string rejection from HTTP host: %s', async message => {
    const sessionService = vi.fn(async () => { throw message })
    expect(await serviceTools[0].execute({ command: 'npm run dev' }, { sessionService } as unknown as ToolContext)).toMatchObject({ ok: false, error: message })
  })
  it('uses the capability and returns real host errors', async () => {
    const sessionService = vi.fn(async () => { throw new Error('Service session is closed') })
    expect(await serviceTools[0].execute({ command: 'npm run dev' }, { sessionService } as unknown as ToolContext)).toMatchObject({ ok: false, error: 'Service session is closed' })
  })
})
