import { describe, expect, it } from 'vitest'
import { DEEPSEEK_BASE_URL, DEEPSEEK_VISION_MODEL } from './deepseek'
import { prepareDeepSeekImageBatch } from './deepseekFiles'
import { encodeDeepSeekMessages } from './deepseekMessages'
import { GLM_BASE_URL } from './glm'
import { KIMI_CN_BASE_URL } from './kimiRegion'
import {
  findProviderRoutePolicy,
  isValidDeepSeekFileId,
  isValidProviderContentType,
  isValidProviderFileName,
  isValidProviderPartName,
  isValidProviderResourceId,
  PROVIDER_OFFICIAL_ORIGINS,
  PROVIDER_ROUTE_POLICIES,
} from './providerTransport'

describe('provider transport policy', () => {
  it('owns every official origin and the complete route metadata table', () => {
    expect(PROVIDER_OFFICIAL_ORIGINS).toEqual({
      deepseek: {
        provider: 'deepseek', scope: 'default', origin: DEEPSEEK_BASE_URL,
      },
      glm: {
        provider: 'glm', scope: 'default', origin: GLM_BASE_URL,
      },
      kimi: {
        provider: 'kimi', scope: 'cn', origin: KIMI_CN_BASE_URL,
      },
    })
    expect(PROVIDER_ROUTE_POLICIES).toHaveLength(8)
  })

  it('uses the adapter base URL bindings as policy origins', () => {
    expect(PROVIDER_OFFICIAL_ORIGINS.deepseek.origin).toBe(DEEPSEEK_BASE_URL)
    expect(PROVIDER_OFFICIAL_ORIGINS.glm.origin).toBe(GLM_BASE_URL)
    expect(PROVIDER_OFFICIAL_ORIGINS.kimi.origin).toBe(KIMI_CN_BASE_URL)
  })

  it('matches exact and provider-owned file routes without accepting suffixes', () => {
    expect(findProviderRoutePolicy({
      provider: 'deepseek', scope: 'default', method: 'POST', path: '/files',
    })?.bodyKind).toBe('multipart')
    expect(findProviderRoutePolicy({
      provider: 'deepseek', scope: 'default', method: 'DELETE',
      path: '/files/file-api-image_one',
    })?.bodyKind).toBe('none')
    expect(findProviderRoutePolicy({
      provider: 'deepseek', scope: 'default', method: 'DELETE',
      path: '/files/file-api-image_one?query=1',
    })).toBeUndefined()
  })
})

describe('provider transport predicates', () => {
  it('applies C0/C1, path, and UTF-8 byte limits to file names', () => {
    for (const value of ['', 'a/b', 'a\\b', 'a\u0000', 'a\u007f', 'a\u0085', '截图'.repeat(43)]) {
      expect(isValidProviderFileName(value)).toBe(false)
    }
    expect(isValidProviderFileName('截图.png')).toBe(true)
    expect(isValidProviderFileName('a .png')).toBe(true)
  })

  it('shares multipart metadata predicates', () => {
    expect(isValidProviderPartName('file_1')).toBe(true)
    expect(isValidProviderPartName('../file')).toBe(false)
    expect(isValidProviderContentType('image/png')).toBe(true)
    expect(isValidProviderContentType('image /png')).toBe(false)
  })

  it('keeps generic resource IDs separate from stricter DeepSeek file IDs', () => {
    expect(isValidProviderResourceId('file.with-dot')).toBe(true)
    expect(isValidDeepSeekFileId('file-api-image_one')).toBe(true)
    for (const value of ['file_123', 'file-api-', 'file-api-.hidden', 'file-api-image.one']) {
      expect(isValidDeepSeekFileId(value)).toBe(false)
    }
  })

  it.each([
    ['file-api-image_one', true],
    ['file-api-image.one', false],
    ['file-api-', false],
    ['file-api-../secret', false],
  ] as const)('keeps upload, message, and deletion decisions aligned for %s', async (id, valid) => {
    const upload = prepareDeepSeekImageBatch([{
      data: new Blob([Uint8Array.of(1)], { type: 'image/png' }),
      name: 'one.png',
      mimeType: 'image/png',
    }], {
      apiKey: 'key',
      fetchImpl: async () => new Response(JSON.stringify({ id })),
    })
    if (valid) await expect(upload).resolves.toBeDefined()
    else await expect(upload).rejects.toThrow('invalid file id')

    const message = () => encodeDeepSeekMessages([{
      role: 'user',
      content: [{
        type: 'image',
        source: {
          kind: 'provider-file', provider: 'deepseek', scope: 'deepseek:default', reference: id,
        },
        name: 'one.png', mimeType: 'image/png', byteSize: 1,
      }],
    }], DEEPSEEK_VISION_MODEL)
    if (valid) expect(message).not.toThrow()
    else expect(message).toThrow('file-api-* id')

    expect(findProviderRoutePolicy({
      provider: 'deepseek', scope: 'default', method: 'DELETE', path: `/files/${id}`,
    }) !== undefined).toBe(valid)
  })
})
