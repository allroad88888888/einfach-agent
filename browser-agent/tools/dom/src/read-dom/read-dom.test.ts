import { expect, it, vi } from 'vitest'
import { createReadDomTool } from './read-dom'
import type { ToolContext } from '@einfach-agent/core/tools'
import type { DomToolsHost } from '../types'
it('read_dom forwards optional first-read filters', async () => { const data = { page: { targetId: 't', documentId: 'd', revision: 1 }, nodes: [], truncated: false }; const readDom = vi.fn(async (_input: unknown) => data); const tool = createReadDomTool({ readDom } as unknown as DomToolsHost); expect(await tool.execute({ text: 'tail' }, { sessionId: 's', signal: new AbortController().signal } as ToolContext)).toEqual({ ok: true, data }); expect(readDom.mock.calls[0]?.[0]).toMatchObject({ text: 'tail' }) })
