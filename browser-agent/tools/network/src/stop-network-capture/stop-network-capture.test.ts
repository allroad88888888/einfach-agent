import { expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createStopNetworkCaptureTool } from './stop-network-capture'

it('forwards capture id and uses the serialized capture effect', async () => {
  const stopCapture = vi.fn().mockResolvedValue({ captureId: 'c1', active: false })
  const tool = createStopNetworkCaptureTool({ stopCapture } as never)
  const ctx = { sessionId: 'session', signal: new AbortController().signal } as ToolContext
  await expect(tool.execute({ captureId: 'c1' }, ctx)).resolves.toMatchObject({ ok: true })
  expect(stopCapture).toHaveBeenCalledWith({ captureId: 'c1' }, { sessionId: 'session', signal: ctx.signal })
  expect(tool.execution).toEqual({ mode: 'serial', effectKeys: ['network:capture'] })
})
