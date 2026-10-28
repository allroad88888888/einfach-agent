import { expect, it, vi } from 'vitest'
import { createWaitForDomTool } from './wait-for-dom'
import type { ToolContext } from '@einfach-agent/core/tools'
import type { DomToolsHost } from '../types'
it('wait_for_dom requires page and forwards conditions', async () => { const data = { page: { targetId: 't', documentId: 'd', revision: 1 }, nodes: [], truncated: false }; const waitForDom = vi.fn(async (_input: unknown) => data); const tool = createWaitForDomTool({ waitForDom } as unknown as DomToolsHost); await tool.execute({ page: data.page, condition: 'absent' }, { sessionId: 's', signal: new AbortController().signal } as ToolContext); expect(waitForDom.mock.calls[0]?.[0]).toMatchObject({ condition: 'absent' }); expect(tool.inputSchema).toMatchObject({ required: ['page'] }) })
