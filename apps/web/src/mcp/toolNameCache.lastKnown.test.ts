import { describe, expect, it } from 'vitest'
import {
  MCP_TOOL_NAME_CACHE_MAX_TOOLS_PER_SERVER,
  findLastKnownToolProvider,
  listLastKnownTools,
  readLastKnownTools,
  setToolNameCacheEntry,
  type McpToolNameCache,
  type McpToolNameCacheProbedTool,
} from './toolNameCache'

function tool(name: string, description = ''): McpToolNameCacheProbedTool {
  return { name, description }
}

// B4 过期语义：读出口只允许把清单当作「上次已知」，任何一次读都必须带上探测时刻。
describe('readLastKnownTools', () => {
  it('hands out the probe time together with the tools, never the tools alone', () => {
    const cache = setToolNameCacheEntry({}, 'github', {
      tools: [tool('create_issue', '新建 issue')],
      probeStatus: 'success',
      cachedAt: 1000,
    })

    expect(readLastKnownTools(cache, 'github')).toEqual({
      serverId: 'github',
      tools: [{ name: 'create_issue', description: '新建 issue' }],
      toolCount: 1,
      truncated: false,
      cachedAt: 1000,
      probeStatus: 'success',
    })
  })

  it('flags a truncated list while keeping the true probed count', () => {
    const tools = Array.from({ length: 250 }, (_, index) => tool(`tool-${index}`))
    const cache = setToolNameCacheEntry({}, 'github', {
      tools,
      probeStatus: 'success',
      cachedAt: 1000,
    })

    const lastKnown = readLastKnownTools(cache, 'github')
    expect(lastKnown?.truncated).toBe(true)
    expect(lastKnown?.toolCount).toBe(250)
    expect(lastKnown?.tools).toHaveLength(MCP_TOOL_NAME_CACHE_MAX_TOOLS_PER_SERVER)
  })

  it('returns undefined for a never-probed server instead of claiming it has no tools', () => {
    expect(readLastKnownTools({}, 'github')).toBeUndefined()
  })

  it('keeps a failed probe readable and distinguishable from a successful empty list', () => {
    const cache = setToolNameCacheEntry({}, 'github', {
      tools: [],
      probeStatus: 'failed',
      cachedAt: 1000,
    })

    expect(readLastKnownTools(cache, 'github')).toMatchObject({
      tools: [],
      truncated: false,
      probeStatus: 'failed',
      cachedAt: 1000,
    })
  })
})

describe('listLastKnownTools', () => {
  it('carries the probe time for every server it lists', () => {
    let cache: McpToolNameCache = setToolNameCacheEntry({}, 'github', {
      tools: [tool('create_issue')],
      probeStatus: 'success',
      cachedAt: 1000,
    })
    cache = setToolNameCacheEntry(cache, 'linear', {
      tools: [],
      probeStatus: 'failed',
      cachedAt: 2000,
    })

    expect(listLastKnownTools(cache).map((entry) => [entry.serverId, entry.cachedAt])).toEqual([
      ['github', 1000],
      ['linear', 2000],
    ])
  })

  it('is empty for an empty cache', () => {
    expect(listLastKnownTools({})).toEqual([])
  })
})

describe('findLastKnownToolProvider', () => {
  const namer = (serverId: string, remoteToolName: string) => `mcp__${serverId}__${remoteToolName}`

  const cache: McpToolNameCache = setToolNameCacheEntry({}, 'github', {
    tools: [tool('create_issue'), tool('list_repos')],
    probeStatus: 'success',
    cachedAt: 1000,
  })

  it('maps a registry tool name back to the server that last reported it', () => {
    expect(findLastKnownToolProvider(cache, 'mcp__github__list_repos', namer)).toEqual({
      serverId: 'github',
      remoteToolName: 'list_repos',
      cachedAt: 1000,
    })
  })

  it('returns undefined for a name no cached server reported', () => {
    expect(findLastKnownToolProvider(cache, 'mcp__github__delete_repo', namer)).toBeUndefined()
    expect(findLastKnownToolProvider(cache, 'write_file', namer)).toBeUndefined()
    expect(findLastKnownToolProvider(cache, '', namer)).toBeUndefined()
  })

  // 注册名不是简单拼接（超长/非法字符会退化成带哈希的形式），所以映射必须由调用方注入，
  // 这里证明查找确实走注入的那一份，而不是在本文件里另抄一套拼法。
  it('resolves the name through the injected namer rather than assuming a shape', () => {
    const hashed = (serverId: string, remoteToolName: string) => `x_${serverId}_${remoteToolName}_9f`

    expect(findLastKnownToolProvider(cache, 'x_github_create_issue_9f', hashed)).toMatchObject({
      serverId: 'github',
      remoteToolName: 'create_issue',
    })
    expect(findLastKnownToolProvider(cache, 'mcp__github__create_issue', hashed)).toBeUndefined()
  })
})
