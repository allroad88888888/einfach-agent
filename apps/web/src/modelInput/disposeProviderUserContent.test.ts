import { describe, expect, it, vi } from 'vitest'
import type { UserImageContentBlock, UserMessageContent } from '@web-agent/ai'
import { disposeProviderUserContent } from './disposeProviderUserContent'

const kimiImage: UserImageContentBlock = {
  type: 'image',
  source: {
    kind: 'provider-file',
    provider: 'kimi',
    scope: 'kimi:cn',
    reference: 'ms://file-one',
  },
  name: 'one.png',
  mimeType: 'image/png',
  byteSize: 10,
}
const kimiContent: UserMessageContent = [kimiImage]

describe('provider user content disposal dispatch', () => {
  it('delegates Kimi CN references through the injected generic provider fetch', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    await disposeProviderUserContent(
      [kimiContent],
      [],
      { settings: { vendor: 'kimi', region: 'cn' } },
      { apiKey: 'desktop-managed', fetchImpl },
    )

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.moonshot.cn/v1/files/file-one',
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bearer desktop-managed' },
      }),
    )
  })

  it('cleans the source owner even after the session switches models', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    const dependencies = { apiKey: 'desktop-managed', fetchImpl }
    await disposeProviderUserContent(
      [kimiContent],
      [],
      { settings: { vendor: 'deepseek' } },
      dependencies,
    )

    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('keeps non-Kimi and gated Kimi global sources untouched', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const dependencies = { apiKey: 'desktop-managed', fetchImpl }
    const nonKimiContent: UserMessageContent = [{
      ...kimiImage,
      source: { ...kimiImage.source, provider: 'other' },
    }]
    const globalKimiContent: UserMessageContent = [{
      ...kimiImage,
      source: { ...kimiImage.source, scope: 'kimi:global' },
    }]
    await disposeProviderUserContent(
      [nonKimiContent],
      [],
      { settings: { vendor: 'kimi', region: 'cn' } },
      dependencies,
    )
    await disposeProviderUserContent(
      [globalKimiContent],
      [],
      { settings: { vendor: 'kimi', region: 'global' } },
      dependencies,
    )

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps a provider file that remains reachable through another message', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await disposeProviderUserContent(
      [kimiContent],
      [kimiContent],
      { settings: { vendor: 'deepseek' } },
      { apiKey: 'desktop-managed', fetchImpl },
    )

    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
