import { describe, expect, it, vi } from 'vitest'
import { makeMcpToolName } from '@web-agent/tools-mcp'
import { createCachedToolProviderProbe } from './cachedToolProviderProbe'
import { setToolNameCacheEntry, type McpToolNameCache } from './toolNameCache'

const CACHE: McpToolNameCache = setToolNameCacheEntry({}, 'github', {
  tools: [{ name: 'create_issue', description: '新建 issue' }],
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
    toRegisteredName: makeMcpToolName,
  })
}

describe('createCachedToolProviderProbe', () => {
  // 真实的 makeMcpToolName：缓存存的是远端工具名，模型调的是注册名，两者必须由同一份映射打通。
  it('places a registry tool name on the unconnected server that last reported it', () => {
    expect(probeWith()(makeMcpToolName('github', 'create_issue'))).toEqual({
      serverId: 'github',
      cachedAt: 1000,
    })
  })

  it('stays silent once that server is connected, so the real list wins', () => {
    const probe = probeWith({ isConnected: (serverId) => serverId === 'github' })

    expect(probe('mcp__github__create_issue')).toBeUndefined()
  })

  it('stays silent for a tool name no cached server reported', () => {
    expect(probeWith()('mcp__github__delete_repo')).toBeUndefined()
    expect(probeWith()('write_file')).toBeUndefined()
  })

  it('stays silent when the cache has not been loaded yet', () => {
    expect(probeWith({ cache: {} })('mcp__github__create_issue')).toBeUndefined()
  })

  it('re-reads the cache on every call so a refreshed probe result is picked up', () => {
    const getCache = vi.fn(() => CACHE)
    const probe = createCachedToolProviderProbe({
      getCache,
      isConnected: () => false,
      toRegisteredName: makeMcpToolName,
    })

    probe('mcp__github__create_issue')
    probe('mcp__github__create_issue')

    expect(getCache).toHaveBeenCalledTimes(2)
  })

  it('fails at assembly time when the host forgets one of the sources', () => {
    expect(() => createCachedToolProviderProbe({
      getCache: () => CACHE,
      toRegisteredName: makeMcpToolName,
    } as unknown as Parameters<typeof createCachedToolProviderProbe>[0])).toThrow('isConnected')
  })
})
