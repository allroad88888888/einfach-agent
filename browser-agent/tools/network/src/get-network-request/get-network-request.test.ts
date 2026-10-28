import { expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createGetNetworkRequestTool } from './get-network-request'

it('forwards request ids and maps host errors', async () => {
  const getRequest = vi.fn().mockResolvedValue({ requestId: 'r1' })
  const tool = createGetNetworkRequestTool({ getRequest } as never)
  const ctx = { sessionId: 'session', signal: new AbortController().signal } as ToolContext
  await expect(tool.execute({ captureId: 'c1', requestId: 'r1' }, ctx)).resolves.toMatchObject({ ok: true })
  expect(getRequest).toHaveBeenCalledWith({ captureId: 'c1', requestId: 'r1' }, { sessionId: 'session', signal: ctx.signal })
  getRequest.mockRejectedValueOnce(new Error('private stack'))
  await expect(tool.execute({ captureId: 'c1', requestId: 'r1' }, ctx)).resolves.toMatchObject({ ok: false, error: 'network capture was not found' })
})
