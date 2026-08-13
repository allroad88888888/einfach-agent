import { describe, expect, it, vi } from 'vitest'
import { makeMcpToolName, type McpToolSnapshot } from '@web-agent/tools-mcp'
import { toolProviderNotConnectedResult } from '@web-agent/core/tools'
import { createCachedToolProviderProbe } from './cachedToolProviderProbe'
import { setToolNameCacheEntry, type McpToolNameCache } from './toolNameCache'
import { toCachedTools } from './toolNameCacheWriter'

// 缓存内容一律用【生产的写入函数】造，不手写工具名字面量：这条反查唯一会出错的地方就是
// 「以为缓存里存的是另一种名字」，fixture 只要自己攒名字，这类错就永远测不出来。
const SNAPSHOT: McpToolSnapshot = {
  name: makeMcpToolName('github', 'create_issue'),
  remoteName: 'create_issue',
  description: '新建 issue',
  inputSchema: { type: 'object' },
}

const CACHE: McpToolNameCache = setToolNameCacheEntry({}, 'github', {
  tools: toCachedTools([SNAPSHOT]),
  probeStatus: 'success',
  cachedAt: 1000,
})

function probeWith(overrides: {
  cache?: McpToolNameCache
  isConnected?: (serverId: string) => boolean
} = {}) {
  return createCachedToolProviderProbe({
    getCache: () => overrides.cache ?? CACHE,
    isConnected: overrides.isConnected ?? (() => false),
  })
}

describe('createCachedToolProviderProbe', () => {
  // 缓存存的就是注册名，模型调的也是注册名：两边同一个字符串，中间不该再有任何名字变换。
  it('places a registry tool name on the unconnected server that last reported it', () => {
    expect(probeWith()(SNAPSHOT.name)).toEqual({
      serverId: 'github',
      cachedAt: 1000,
    })
  })

  // 端到端语义（B4）：模型照着缓存清单点名调用 → 探针认出提供方 → 回执把该连的 serverId
  // 说给模型。这条链断在中间任何一环，模型收到的都还是那句没有出路的 unknown tool。
  it('hands the not-connected receipt the server the model has to connect', () => {
    const provider = probeWith()(SNAPSHOT.name)
    if (!provider) throw new Error('探针没认出这个注册名，B4 回执根本不会被触发')

    const receipt = toolProviderNotConnectedResult(SNAPSHOT.name, provider)

    expect(receipt).toMatchObject({
      code: 'tool_provider_not_connected',
      serverId: 'github',
      nextCall: { arguments: { serverId: 'github' } },
    })
    expect(receipt.error).toContain(SNAPSHOT.name)
  })

  it('stays silent once that server is connected, so the real list wins', () => {
    const probe = probeWith({ isConnected: (serverId) => serverId === 'github' })

    expect(probe('mcp__github__create_issue')).toBeUndefined()
  })

  it('stays silent for a tool name no cached server reported', () => {
    expect(probeWith()('mcp__github__delete_repo')).toBeUndefined()
    expect(probeWith()('write_file')).toBeUndefined()
    // 远端原名不是模型手里的名字；它能命中就说明探针在自己拆注册名的形状。
    expect(probeWith()('create_issue')).toBeUndefined()
  })

  it('stays silent when the cache has not been loaded yet', () => {
    expect(probeWith({ cache: {} })('mcp__github__create_issue')).toBeUndefined()
  })

  it('re-reads the cache on every call so a refreshed probe result is picked up', () => {
    const getCache = vi.fn(() => CACHE)
    const probe = createCachedToolProviderProbe({ getCache, isConnected: () => false })

    probe('mcp__github__create_issue')
    probe('mcp__github__create_issue')

    expect(getCache).toHaveBeenCalledTimes(2)
  })

  it('fails at assembly time when the host forgets one of the sources', () => {
    expect(() => createCachedToolProviderProbe({
      getCache: () => CACHE,
    } as unknown as Parameters<typeof createCachedToolProviderProbe>[0])).toThrow('isConnected')
  })
})
