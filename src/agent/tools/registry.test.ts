import { describe, expect, it } from 'vitest'
import { listToolSummaries, loadTool, searchTools } from './registry'

describe('tool registry', () => {
  it('lists summaries without full schemas', () => {
    const tools = listToolSummaries()

    expect(tools.map((tool) => tool.name)).toEqual([
      'ask_user_question',
      'skill_search',
      'skill_read',
      'delegate_agent',
      'browser_action',
      'save_file',
    ])
    expect(tools[0]).not.toHaveProperty('inputSchema')
  })

  it('loads a schema only when requested', () => {
    const tool = loadTool('ask_user_question')

    expect(tool?.runtime).toBe('internal')
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['id', 'questions'],
    })
  })

  it('registers save_file as a browser runtime tool with a content schema', () => {
    const tool = loadTool('save_file')

    expect(tool?.runtime).toBe('browser')
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['filename', 'content'],
    })
  })

  it('searches by runtime and description', () => {
    expect(searchTools('browser').map((tool) => tool.name)).toContain('browser_action')
    expect(searchTools('delegate_agent').map((tool) => tool.name)).toEqual(['delegate_agent'])
    expect(searchTools('委托').map((tool) => tool.name)).toEqual(['delegate_agent'])
    expect(loadTool('missing_tool')).toBeUndefined()
  })
})
