import { describe, expect, it, vi } from 'vitest'
import type { UserImageContentBlock, UserMessageContent } from './modelProtocol'
import { disposeKimiUserContent } from './kimiFileDisposal'

function image(
  reference: string,
  provider = 'kimi',
  scope = 'kimi:cn',
): UserImageContentBlock {
  return {
    type: 'image',
    source: { kind: 'provider-file', provider, scope, reference },
    name: 'image.png',
    mimeType: 'image/png',
    byteSize: 10,
  }
}

describe('Kimi committed file disposal', () => {
  it('deduplicates discarded ids and subtracts every retained reference', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    const discarded: UserMessageContent[] = [
      [image('ms://delete-me'), image('ms://keep-me')],
      [image('ms://delete-me')],
    ]
    await disposeKimiUserContent(discarded, [[image('ms://keep-me')]], {
      apiKey: 'managed',
      fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.moonshot.cn/v1/files/delete-me',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('ignores malformed references and images owned by another provider or scope', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await disposeKimiUserContent([[
      image('https://example.com/file'),
      image('ms://bad/path'),
      image('ms://global-file', 'kimi', 'kimi:global'),
      image('ms://other-file', 'other', 'kimi:cn'),
    ]], [], { apiKey: 'managed', fetchImpl })

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('treats 404, 500, and transport rejection as best-effort outcomes', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockRejectedValueOnce(new Error('offline'))

    await expect(disposeKimiUserContent([[
      image('ms://already-gone'),
      image('ms://server-error'),
      image('ms://network-error'),
    ]], [], { apiKey: 'managed', fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})
