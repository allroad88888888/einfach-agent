import { describe, expect, it } from 'vitest'
import { MCP_CONNECT_TOOL_NAME } from '../runtime/dangerousTools'
import {
  TOOL_PROVIDER_NOT_CONNECTED_CODE,
  toolProviderNotConnectedResult,
} from './schemaResult'

const LAST_KNOWN_AT = Date.UTC(2026, 0, 2, 3, 4, 5)

describe('toolProviderNotConnectedResult', () => {
  it('names the owning server and hands the model an executable next step', () => {
    const result = toolProviderNotConnectedResult('mcp__github__create_issue', {
      serverId: 'github',
      cachedAt: LAST_KNOWN_AT,
    })

    expect(result).toMatchObject({
      code: TOOL_PROVIDER_NOT_CONNECTED_CODE,
      executed: false,
      retryable: false,
      serverId: 'github',
      nextCall: { name: MCP_CONNECT_TOOL_NAME, arguments: { serverId: 'github' } },
    })
    expect(result.error).toContain('mcp__github__create_issue')
    expect(result.error).toContain('github')
  })

  it('presents the tool list as last-known rather than as current fact', () => {
    const result = toolProviderNotConnectedResult('mcp__github__create_issue', {
      serverId: 'github',
      cachedAt: LAST_KNOWN_AT,
    })

    expect(result.lastKnownAt).toBe('2026-01-02T03:04:05.000Z')
    expect(result.hint).toContain('上次已知')
    expect(result.hint).toContain('2026-01-02T03:04:05.000Z')
    // 连上之后以真实清单为准：不能让模型照抄这次的名字与参数。
    expect(result.hint).toContain('真实清单为准')
    expect(result.hint).toContain('不要沿用本次猜测的参数')
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['out of Date range', 8.64e15 + 1],
  ])('degrades an unusable cachedAt (%s) to 时间未知 instead of inventing freshness', (_label, cachedAt) => {
    const result = toolProviderNotConnectedResult('mcp__foo__bar', { serverId: 'foo', cachedAt })

    expect(result.lastKnownAt).toBe('时间未知')
    expect(result.hint).toContain('上次已知')
    expect(result.hint).toContain('时间未知')
    expect(result.hint).not.toContain('Invalid Date')
  })

  it('tells the model that retrying the same call changes nothing', () => {
    const result = toolProviderNotConnectedResult('mcp__foo__bar', {
      serverId: 'foo',
      cachedAt: LAST_KNOWN_AT,
    })

    expect(result.hint).toContain('本次调用未执行')
    expect(result.hint).toContain('原样重试')
    expect(result.hint).toContain(MCP_CONNECT_TOOL_NAME)
  })
})
