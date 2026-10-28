import { expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createListNetworkRequestsTool } from './list-network-requests'

it('forwards pagination and filters', async () => {
  const listRequests = vi.fn().mockResolvedValue({ requests: [] })
  const tool = createListNetworkRequestsTool({ listRequests } as never)
  const ctx = { sessionId: 'session', signal: new AbortController().signal } as ToolContext
  const input = { captureId: 'c1', offset: 2, limit: 4, method: 'POST' }
  await expect(tool.execute(input, ctx)).resolves.toMatchObject({ ok: true })
  expect(listRequests).toHaveBeenCalledWith(input, { sessionId: 'session', signal: ctx.signal })
})
