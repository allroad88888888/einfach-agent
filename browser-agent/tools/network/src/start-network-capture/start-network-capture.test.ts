import { expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createStartNetworkCaptureTool } from './start-network-capture'

it('forwards capture options and context', async () => {
  const startCapture = vi.fn().mockResolvedValue({ captureId: 'c1' })
  const tool = createStartNetworkCaptureTool({ startCapture } as never)
  const ctx = { sessionId: 'session', signal: new AbortController().signal } as ToolContext
  const input = { methods: ['post'], includeBuffered: false }
  await expect(tool.execute(input, ctx)).resolves.toMatchObject({ ok: true, data: { captureId: 'c1' } })
  expect(startCapture).toHaveBeenCalledWith(input, { sessionId: 'session', signal: ctx.signal })
})
