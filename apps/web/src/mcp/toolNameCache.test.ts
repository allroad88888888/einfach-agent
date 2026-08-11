import { describe, expect, it } from 'vitest'
import {
  MCP_TOOL_NAME_CACHE_DESCRIPTION_MAX_CHARS,
  MCP_TOOL_NAME_CACHE_MAX_TOOLS_PER_SERVER,
  MCP_TOOL_NAME_CACHE_TOTAL_MAX_CHARS,
  removeToolNameCacheEntry,
  sanitizeToolNameCache,
  setToolNameCacheEntry,
  type McpToolNameCache,
  type McpToolNameCacheProbedTool,
} from './toolNameCache'

function tool(name: string, description = ''): McpToolNameCacheProbedTool {
  return { name, description }
}

describe('setToolNameCacheEntry', () => {
  it('stores tools, toolCount, cachedAt and probeStatus for a server', () => {
    const cache = setToolNameCacheEntry({}, 'server-a', {
      tools: [tool('read_file', '读取文件内容'), tool('write_file', '写入文件内容')],
      probeStatus: 'success',
      cachedAt: 1000,
    })

    expect(cache['server-a']).toEqual({
      tools: [
        { name: 'read_file', description: '读取文件内容' },
        { name: 'write_file', description: '写入文件内容' },
      ],
      toolCount: 2,
      cachedAt: 1000,
      probeStatus: 'success',
    })
  })

  it('defaults cachedAt to the current time when not supplied', () => {
    const before = Date.now()
    const cache = setToolNameCacheEntry({}, 'server-a', {
      tools: [],
      probeStatus: 'failed',
    })
    const after = Date.now()

    expect(cache['server-a']?.cachedAt).toBeGreaterThanOrEqual(before)
    expect(cache['server-a']?.cachedAt).toBeLessThanOrEqual(after)
  })

  it('records a failed probe with an empty tool list without dropping the entry', () => {
    const cache = setToolNameCacheEntry({}, 'server-a', {
      tools: [],
      probeStatus: 'failed',
      cachedAt: 1000,
    })

    expect(cache['server-a']).toEqual({
      tools: [],
      toolCount: 0,
      cachedAt: 1000,
      probeStatus: 'failed',
    })
  })

  it('caps the cached tool list per server while keeping the true reported count', () => {
    const tools = Array.from({ length: 250 }, (_, index) => tool(`tool-${index}`))

    const cache = setToolNameCacheEntry({}, 'server-a', {
      tools,
      probeStatus: 'success',
      cachedAt: 1000,
    })

    expect(cache['server-a']?.tools).toHaveLength(MCP_TOOL_NAME_CACHE_MAX_TOOLS_PER_SERVER)
    expect(cache['server-a']?.toolCount).toBe(250)
  })

  it('truncates an overlong description with an ellipsis instead of dropping the tool', () => {
    const cache = setToolNameCacheEntry({}, 'server-a', {
      tools: [tool('long_tool', 'y'.repeat(300))],
      probeStatus: 'success',
      cachedAt: 1000,
    })

    const description = cache['server-a']?.tools[0]?.description ?? ''
    expect(description).toHaveLength(MCP_TOOL_NAME_CACHE_DESCRIPTION_MAX_CHARS)
    expect(description.endsWith('…')).toBe(true)
  })

  it('drops tools with an empty or missing name but keeps the valid ones', () => {
    const cache = setToolNameCacheEntry({}, 'server-a', {
      tools: [tool('ok'), { name: '  ' }, tool('also_ok')],
      probeStatus: 'success',
      cachedAt: 1000,
    })

    expect(cache['server-a']?.tools.map((entry) => entry.name)).toEqual(['ok', 'also_ok'])
    // toolCount reflects what the probe reported, independent of shape-validation drops.
    expect(cache['server-a']?.toolCount).toBe(3)
  })

  it('enforces the total cache budget by trimming only the entry currently being written', () => {
    const bigDescription = 'x'.repeat(MCP_TOOL_NAME_CACHE_DESCRIPTION_MAX_CHARS)
    const heavyTools = Array.from({ length: 150 }, (_, index) => tool(`tool-${index}`, bigDescription))

    let cache: McpToolNameCache = setToolNameCacheEntry({}, 'server-small', {
      tools: [tool('untouched')],
      probeStatus: 'success',
      cachedAt: 1000,
    })
    const before = cache['server-small']

    cache = setToolNameCacheEntry(cache, 'server-heavy', {
      tools: heavyTools,
      probeStatus: 'success',
      cachedAt: 2000,
    })

    // The pre-existing small entry must be byte-for-byte unaffected by a heavy sibling write.
    expect(cache['server-small']).toEqual(before)
    // The heavy entry itself absorbs the trim: fewer cached tools than reported, but the
    // real count is preserved so callers still know how many tools the server actually has.
    expect(cache['server-heavy']?.tools.length).toBeLessThan(150)
    expect(cache['server-heavy']?.toolCount).toBe(150)
    expect(JSON.stringify(cache).length).toBeLessThanOrEqual(MCP_TOOL_NAME_CACHE_TOTAL_MAX_CHARS)
  })

  it('lets independent servers coexist without interfering when both fit the budget', () => {
    let cache: McpToolNameCache = setToolNameCacheEntry({}, 'server-a', {
      tools: [tool('a1')],
      probeStatus: 'success',
      cachedAt: 1000,
    })
    cache = setToolNameCacheEntry(cache, 'server-b', {
      tools: [tool('b1')],
      probeStatus: 'success',
      cachedAt: 2000,
    })

    expect(cache['server-a']?.tools).toEqual([{ name: 'a1', description: '' }])
    expect(cache['server-b']?.tools).toEqual([{ name: 'b1', description: '' }])
  })

  it('rejects an empty serverId', () => {
    expect(() =>
      setToolNameCacheEntry({}, '', { tools: [], probeStatus: 'success' }),
    ).toThrow('serverId')
  })
})

describe('removeToolNameCacheEntry', () => {
  it('removes an existing entry and leaves the rest untouched', () => {
    const cache = setToolNameCacheEntry(
      setToolNameCacheEntry({}, 'server-a', { tools: [tool('a1')], probeStatus: 'success', cachedAt: 1 }),
      'server-b',
      { tools: [tool('b1')], probeStatus: 'success', cachedAt: 2 },
    )

    const next = removeToolNameCacheEntry(cache, 'server-a')

    expect(next['server-a']).toBeUndefined()
    expect(next['server-b']).toEqual(cache['server-b'])
  })

  it('returns the same cache reference when the serverId is not present (missing service)', () => {
    const cache = setToolNameCacheEntry({}, 'server-a', { tools: [], probeStatus: 'success', cachedAt: 1 })

    expect(removeToolNameCacheEntry(cache, 'no-such-server')).toBe(cache)
  })
})

describe('sanitizeToolNameCache (corrupted data degradation)', () => {
  it('degrades non-object input to an empty cache instead of throwing', () => {
    expect(sanitizeToolNameCache(null)).toEqual({})
    expect(sanitizeToolNameCache('garbage')).toEqual({})
    expect(sanitizeToolNameCache(42)).toEqual({})
    expect(sanitizeToolNameCache(['not', 'a', 'record'])).toEqual({})
  })

  it('drops an entry with an invalid probeStatus', () => {
    const cache = sanitizeToolNameCache({
      'server-a': { tools: [], toolCount: 0, cachedAt: 1, probeStatus: 'pending' },
    })

    expect(cache['server-a']).toBeUndefined()
  })

  it('drops an entry with a missing or non-numeric cachedAt', () => {
    const cache = sanitizeToolNameCache({
      'server-a': { tools: [], toolCount: 0, probeStatus: 'success' },
      'server-b': { tools: [], toolCount: 0, cachedAt: 'yesterday', probeStatus: 'success' },
    })

    expect(cache['server-a']).toBeUndefined()
    expect(cache['server-b']).toBeUndefined()
  })

  it('degrades a non-array tools field to an empty list but keeps the rest of the record', () => {
    const cache = sanitizeToolNameCache({
      'server-a': { tools: 'garbage', toolCount: 5, cachedAt: 1, probeStatus: 'success' },
    })

    expect(cache['server-a']).toEqual({ tools: [], toolCount: 5, cachedAt: 1, probeStatus: 'success' })
  })

  it('drops individual malformed tool entries but keeps the valid ones', () => {
    const cache = sanitizeToolNameCache({
      'server-a': {
        tools: [{ name: 'ok' }, { no: 'name' }, { name: '' }, 'not-even-an-object'],
        toolCount: 1,
        cachedAt: 1,
        probeStatus: 'success',
      },
    })

    expect(cache['server-a']?.tools).toEqual([{ name: 'ok', description: '' }])
  })

  it('falls back toolCount to the sanitized tool count when the stored value is missing or invalid', () => {
    const cache = sanitizeToolNameCache({
      'server-a': { tools: [{ name: 'a' }, { name: 'b' }], cachedAt: 1, probeStatus: 'success' },
      'server-b': { tools: [{ name: 'a' }], toolCount: -1, cachedAt: 1, probeStatus: 'success' },
    })

    expect(cache['server-a']?.toolCount).toBe(2)
    expect(cache['server-b']?.toolCount).toBe(1)
  })

  it('round-trips a well-formed cache through JSON without loss', () => {
    const original = setToolNameCacheEntry({}, 'server-a', {
      tools: [tool('a1', '描述')],
      probeStatus: 'success',
      cachedAt: 1000,
    })

    expect(sanitizeToolNameCache(JSON.parse(JSON.stringify(original)))).toEqual(original)
  })

  it('re-enforces the total budget when loading an already oversized cache', () => {
    const bigDescription = 'x'.repeat(MCP_TOOL_NAME_CACHE_DESCRIPTION_MAX_CHARS)
    const heavyTools = Array.from({ length: 150 }, (_, index) => ({
      name: `tool-${index}`,
      description: bigDescription,
    }))

    const cache = sanitizeToolNameCache({
      'server-a': { tools: heavyTools, toolCount: 150, cachedAt: 1, probeStatus: 'success' },
    })

    expect(JSON.stringify(cache).length).toBeLessThanOrEqual(MCP_TOOL_NAME_CACHE_TOTAL_MAX_CHARS)
    expect(cache['server-a']?.toolCount).toBe(150)
  })
})
