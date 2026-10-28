import { expect, it, vi } from 'vitest'
import { createScrollDomTool } from './scroll-dom'
import type { ToolContext } from '@einfach-agent/core/tools'
import type { DomToolsHost } from '../types'
it('scroll_dom forwards direction and amount', async () => { const scrollDom = vi.fn(async (input) => ({ page: input.page, ref: input.ref, dispatched: true as const })); const tool = createScrollDomTool({ scrollDom } as unknown as DomToolsHost); await tool.execute({ page: { targetId: 't', documentId: 'd', revision: 1 }, ref: 'dom-1', direction: 'down', amount: 80 }, { sessionId: 's', signal: new AbortController().signal } as ToolContext); expect(scrollDom.mock.calls[0]?.[0]).toMatchObject({ direction: 'down', amount: 80 }) })
