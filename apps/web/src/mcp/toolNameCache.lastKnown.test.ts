import { describe, expect, it } from 'vitest'
import { makeMcpToolName } from '@web-agent/tools-mcp'
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
  // 【fixture 必须是注册名】生产写入路径（toolNameCacheWriter 的 toCachedTools）存进来的是
  // McpToolSnapshot.name，也就是 makeMcpToolName 的产出。早先这里用远端原名做 fixture，
  // 于是"反查时再拼一次注册名"这个双重前缀的 bug 在测试里一直是绿的，生产里却从未命中。
  const cache: McpToolNameCache = setToolNameCacheEntry({}, 'github', {
    tools: [
      tool(makeMcpToolName('github', 'create_issue')),
      tool(makeMcpToolName('github', 'list_repos')),
    ],
    probeStatus: 'success',
    cachedAt: 1000,
  })

  it('maps a registry tool name back to the server that last reported it', () => {
    expect(findLastKnownToolProvider(cache, 'mcp__github__list_repos')).toEqual({
      serverId: 'github',
      cachedAt: 1000,
    })
  })

  it('returns undefined for a name no cached server reported', () => {
    expect(findLastKnownToolProvider(cache, 'mcp__github__delete_repo')).toBeUndefined()
    expect(findLastKnownToolProvider(cache, 'write_file')).toBeUndefined()
    expect(findLastKnownToolProvider(cache, '')).toBeUndefined()
  })

  // 模型手里只有注册名。远端原名也能查到就说明反查在自己拆名字的形状，那正是双重前缀的来路。
  it('does not answer for the remote tool name buried inside a registry name', () => {
    expect(findLastKnownToolProvider(cache, 'create_issue')).toBeUndefined()
  })

  // 注册名超长或含非法字符时会退化成带哈希的形式，不可反解析；缓存里存的就是这份成品，
  // 所以反查只能逐字比较——任何"在这里重拼一次"的写法都会在这条用例上翻车。
  it('matches a hashed registry name verbatim', () => {
    const remoteName = `${'search_'.repeat(12)}issues`
    const hashedName = makeMcpToolName('github', remoteName)
    expect(hashedName).not.toBe(`mcp__github__${remoteName}`)

    const hashedCache = setToolNameCacheEntry({}, 'github', {
      tools: [tool(hashedName)],
      probeStatus: 'success',
      cachedAt: 2000,
    })

    expect(findLastKnownToolProvider(hashedCache, hashedName)).toEqual({
      serverId: 'github',
      cachedAt: 2000,
    })
  })
})
