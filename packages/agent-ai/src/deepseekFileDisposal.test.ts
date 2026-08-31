import { describe, expect, it, vi } from 'vitest'
import { disposeDeepSeekProviderFiles } from './deepseekFileDisposal'
import type { UserImageContentBlock, UserMessageContent } from './modelProtocol'

function image(
  reference: string,
  provider = 'deepseek',
  scope = 'deepseek:default',
): UserImageContentBlock {
  return {
    type: 'image',
    source: { kind: 'provider-file', provider, scope, reference },
    name: 'image.png',
    mimeType: 'image/png',
    byteSize: 10,
  }
}

describe('DeepSeek provider file disposal', () => {
  it('deduplicates discarded ids and protects every retained reference', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    const discarded: UserMessageContent[] = [
      [image('file-api-delete'), image('file-api-keep')],
      [image('file-api-delete')],
    ]

    await disposeDeepSeekProviderFiles(discarded, [[image('file-api-keep')]], {
      apiKey: 'managed',
      fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.deepseek.com/files/file-api-delete',
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer managed' },
      },
    )
  })

  it('ignores malformed, Kimi, wrong-scope, and foreign-provider references', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await disposeDeepSeekProviderFiles([[
      image('ms://kimi-file'),
      image('file-api-../path'),
      image('file-api-wrong-scope', 'deepseek', 'deepseek:other'),
      image('file-api-foreign', 'other'),
    ]], [], { apiKey: 'managed', fetchImpl })

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('treats HTTP errors and transport rejection as best-effort outcomes', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockRejectedValueOnce(new Error('offline'))

    await expect(disposeDeepSeekProviderFiles([[
      image('file-api-already-gone'),
      image('file-api-server-error'),
      image('file-api-network-error'),
    ]], [], { apiKey: 'managed', fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})
