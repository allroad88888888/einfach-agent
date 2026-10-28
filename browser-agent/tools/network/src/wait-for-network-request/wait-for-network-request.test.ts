import { expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createWaitForNetworkRequestTool } from './wait-for-network-request'

it('forwards wait state, timeout, and cancellation signal', async () => {
  const waitForRequest = vi.fn().mockResolvedValue({ requestId: 'r1' })
  const tool = createWaitForNetworkRequestTool({ waitForRequest } as never)
  const ctx = { sessionId: 'session', signal: new AbortController().signal } as ToolContext
  const input = { captureId: 'c1', state: 'started' as const, timeoutMs: 20 }
  await expect(tool.execute(input, ctx)).resolves.toMatchObject({ ok: true })
  expect(waitForRequest).toHaveBeenCalledWith(input, { sessionId: 'session', signal: ctx.signal })
})
