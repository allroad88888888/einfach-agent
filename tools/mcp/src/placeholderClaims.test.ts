import type { Tool } from '@web-agent/core/tools/types'
import { describe, expect, it } from 'vitest'
import { createMcpPlaceholderClaims } from './placeholderClaims'

/** 登记表只记账：这里全部断言都不涉及 ToolRegistry。 */

function placeholderTool(name: string): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: 'placeholder', content: 'placeholder guide' },
    inputSchema: { type: 'object' },
    execute: () => ({ ok: true }),
  }
}

describe('占位登记表的权属判定', () => {
  it('owns 只认登记，不认名字长相', () => {
    const claims = createMcpPlaceholderClaims()
    const tool = placeholderTool('mcp__alpha__read')

    expect(claims.owns('alpha', 'mcp__alpha__read')).toBe(false)
    expect(claims.claim('alpha', 'mcp__alpha__read', tool)).toBe(true)

    expect(claims.owns('alpha', 'mcp__alpha__read')).toBe(true)
    // 名字里写着 alpha 也不代表 beta 能声称它——权属只来自登记。
    expect(claims.owns('beta', 'mcp__alpha__read')).toBe(false)
    expect(claims.get('mcp__alpha__read')).toEqual({ serverId: 'alpha', tool })
  })

  it('跨服务撞名先到先得：后者被拒且不覆盖', () => {
    const claims = createMcpPlaceholderClaims()
    const first = placeholderTool('shared')
    const second = placeholderTool('shared')

    expect(claims.claim('alpha', 'shared', first)).toBe(true)
    expect(claims.claim('beta', 'shared', second)).toBe(false)
    expect(claims.get('shared')).toEqual({ serverId: 'alpha', tool: first })
  })

  it('本服务重复登记视为刷新：换实例、仍归本服务', () => {
    const claims = createMcpPlaceholderClaims()
    const stale = placeholderTool('mcp__alpha__read')
    const fresh = placeholderTool('mcp__alpha__read')

    claims.claim('alpha', 'mcp__alpha__read', stale)
    expect(claims.claim('alpha', 'mcp__alpha__read', fresh)).toBe(true)
    expect(claims.get('mcp__alpha__read')?.tool).toBe(fresh)
  })
})

describe('占位登记表的释放与清点', () => {
  it('release 的 expected 形式挡住旧持有者的误伤', () => {
    const claims = createMcpPlaceholderClaims()
    const stale = placeholderTool('mcp__alpha__read')
    const fresh = placeholderTool('mcp__alpha__read')
    claims.claim('alpha', 'mcp__alpha__read', stale)
    claims.claim('alpha', 'mcp__alpha__read', fresh)

    expect(claims.release('mcp__alpha__read', stale)).toBe(false)
    expect(claims.owns('alpha', 'mcp__alpha__read')).toBe(true)

    expect(claims.release('mcp__alpha__read', fresh)).toBe(true)
    expect(claims.get('mcp__alpha__read')).toBeUndefined()
    // 释放一个没人占的名字不是错误，只是没做成。
    expect(claims.release('mcp__alpha__read', fresh)).toBe(false)
  })

  it('namesFor 只报本服务占着的名字', () => {
    const claims = createMcpPlaceholderClaims()
    claims.claim('alpha', 'mcp__alpha__read', placeholderTool('mcp__alpha__read'))
    claims.claim('alpha', 'mcp__alpha__write', placeholderTool('mcp__alpha__write'))
    claims.claim('beta', 'mcp__beta__read', placeholderTool('mcp__beta__read'))

    expect(claims.namesFor('alpha').sort()).toEqual(['mcp__alpha__read', 'mcp__alpha__write'])
    expect(claims.namesFor('beta')).toEqual(['mcp__beta__read'])
    expect(claims.namesFor('gamma')).toEqual([])

    claims.release('mcp__alpha__read')
    expect(claims.namesFor('alpha')).toEqual(['mcp__alpha__write'])
  })
})
