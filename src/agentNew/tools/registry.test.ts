import { describe, it, expect } from 'vitest'
import { listToolSummaries, searchTools, loadTool } from './registry'

describe('tools/registry（agentNew · 移植裁剪版）', () => {
  it('listToolSummaries 返回 5 项，且每项都是 manifest-only（无 inputSchema 键）', () => {
    const summaries = listToolSummaries()

    expect(summaries).toHaveLength(5)
    for (const summary of summaries) {
      // manifest-only（TK3）：摘要里只有 name/description/runtime，绝不带 schema。
      expect(summary).not.toHaveProperty('inputSchema')
    }
  })

  it('裁剪掉 delegate_agent：摘要里不含它（TK2）', () => {
    const names = listToolSummaries().map((tool) => tool.name)

    expect(names).not.toContain('delegate_agent')
    expect(names).toEqual(
      expect.arrayContaining([
        'skill_search',
        'skill_read',
        'ask_user_question',
        'browser_action',
        'save_file',
      ]),
    )
  })

  it('loadTool 懒加载：save_file 合成出含 inputSchema 的完整 LoadedTool（TK3）', () => {
    const tool = loadTool('save_file')

    expect(tool).toBeDefined()
    expect(tool?.name).toBe('save_file')
    expect(tool?.runtime).toBe('browser')
    expect(tool?.inputSchema).toBeDefined()
    expect(tool?.inputSchema).toMatchObject({ type: 'object' })
  })

  it('loadTool 未知名字返回 undefined', () => {
    expect(loadTool('nope')).toBeUndefined()
    // 已裁剪的 tool 也不可加载。
    expect(loadTool('delegate_agent')).toBeUndefined()
  })

  it('browser_action schema：payload.properties 只有 title/body，不含 items/options（契约一致性）', () => {
    const tool = loadTool('browser_action')
    const schema = tool?.inputSchema as {
      properties?: { payload?: { properties?: Record<string, unknown>; required?: string[] } }
    }
    const payloadProps = schema.properties?.payload?.properties ?? {}

    // schema 广告的字段必须与执行侧（BrowserCard 只存 title/body）一致——去掉 items/options。
    expect(payloadProps).not.toHaveProperty('items')
    expect(payloadProps).not.toHaveProperty('options')
    expect(payloadProps).toHaveProperty('title')
    expect(payloadProps).toHaveProperty('body')
    expect(schema.properties?.payload?.required).toEqual(['title'])
  })

  it('searchTools 子串匹配命中 skill_search + skill_read', () => {
    const hits = searchTools('skill').map((tool) => tool.name)

    expect(hits).toContain('skill_search')
    expect(hits).toContain('skill_read')
  })

  it('searchTools 也可按 runtime 匹配（browser 命中 browser_action + save_file）', () => {
    const hits = searchTools('browser').map((tool) => tool.name)

    expect(hits).toContain('browser_action')
    expect(hits).toContain('save_file')
  })
})
