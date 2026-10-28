import { expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createGetNetworkResponseTool } from './get-network-response'

it('forwards response ids and maps host errors', async () => {
  const getResponse = vi.fn().mockResolvedValue({ requestId: 'r1' })
  const tool = createGetNetworkResponseTool({ getResponse } as never)
  const ctx = { sessionId: 'session', signal: new AbortController().signal } as ToolContext
  await expect(tool.execute({ captureId: 'c1', requestId: 'r1' }, ctx)).resolves.toMatchObject({ ok: true })
  expect(getResponse).toHaveBeenCalledWith({ captureId: 'c1', requestId: 'r1' }, { sessionId: 'session', signal: ctx.signal })
  getResponse.mockRejectedValueOnce(new Error('private stack'))
  await expect(tool.execute({ captureId: 'c1', requestId: 'r1' }, ctx)).resolves.toMatchObject({ ok: false, error: 'network capture was not found' })
})
