import { expect, it, vi } from 'vitest'
import { createPressDomKeyTool } from './press-dom-key'
import type { ToolContext } from '@einfach-agent/core/tools'
import type { DomToolsHost } from '../types'
it('press_dom_key forwards one key request', async () => { const pressDomKey = vi.fn(async (input) => ({ page: input.page, ref: input.ref, dispatched: true as const })); const tool = createPressDomKeyTool({ pressDomKey } as unknown as DomToolsHost); await tool.execute({ page: { targetId: 't', documentId: 'd', revision: 1 }, ref: 'dom-1', key: 'Enter' }, { sessionId: 's', signal: new AbortController().signal } as ToolContext); expect(pressDomKey.mock.calls[0]?.[0]).toMatchObject({ key: 'Enter' }) })
