import { describe, expect, it, vi } from 'vitest'
import type { ToolRegistry } from '@einfach-agent/core/tools'
import { createDomTools, registerDomTools } from './register'
import type { DomToolsHost } from './types'

const host = {} as DomToolsHost
describe('DOM tool registration', () => {
  it('creates and registers all six tools in contract order', () => {
    const tools = createDomTools(host); expect(tools.map((tool) => tool.name)).toEqual(['read_dom', 'click_dom', 'type_dom', 'press_dom_key', 'scroll_dom', 'wait_for_dom'])
    for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
    const register = vi.fn(); registerDomTools({ register } as unknown as ToolRegistry, host); expect(register).toHaveBeenCalledTimes(6)
  })
})
