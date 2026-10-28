import { expect, it, vi } from 'vitest'
import { createTypeDomTool } from './type-dom'
import type { ToolContext } from '@einfach-agent/core/tools'
import type { DomToolsHost } from '../types'
it('type_dom forwards bounded text', async () => { const typeDom = vi.fn(async (input) => ({ page: input.page, ref: input.ref, dispatched: true as const })); const tool = createTypeDomTool({ typeDom } as unknown as DomToolsHost); await tool.execute({ page: { targetId: 't', documentId: 'd', revision: 1 }, ref: 'dom-1', text: 'query' }, { sessionId: 's', signal: new AbortController().signal } as ToolContext); expect(typeDom.mock.calls[0]?.[0]).toMatchObject({ text: 'query' }); expect(tool.inputSchema).toMatchObject({ required: ['page', 'ref', 'text'] }) })
