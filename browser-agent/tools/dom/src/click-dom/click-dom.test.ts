import { expect, it, vi } from 'vitest'
import { createClickDomTool } from './click-dom'
import type { ToolContext } from '@einfach-agent/core/tools'
import type { DomToolsHost } from '../types'
it('click_dom requires page and exact ref in its schema', async () => { const clickDom = vi.fn(async (input) => ({ ...input, dispatched: true as const })); const tool = createClickDomTool({ clickDom } as unknown as DomToolsHost); expect(tool.inputSchema).toMatchObject({ required: ['page', 'ref'] }); await tool.execute({ page: { targetId: 't', documentId: 'd', revision: 1 }, ref: 'dom-1' }, { sessionId: 's', signal: new AbortController().signal } as ToolContext); expect(clickDom).toHaveBeenCalledOnce() })
