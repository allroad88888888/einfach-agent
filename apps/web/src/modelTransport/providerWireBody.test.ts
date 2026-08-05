import type { ProviderTransportInput, ProviderTarget } from '@web-agent/ai'
import { describe, expect, it } from 'vitest'
import { encodeProviderWireBody } from './providerWireBody'

const uploadTarget = {
  provider: 'kimi', scope: 'cn', method: 'POST', path: '/files',
} as const

describe('encodeProviderWireBody', () => {
  it('preserves multipart order while encoding binary data', async () => {
    await expect(encodeProviderWireBody({
      target: uploadTarget,
      body: {
        kind: 'multipart',
        parts: [
          { kind: 'text', name: 'purpose', value: 'file-extract' },
          {
            kind: 'file',
            name: 'file',
            fileName: 'image.png',
            contentType: 'image/png',
            data: new Blob([Uint8Array.of(1, 2, 3)]),
          },
        ],
      },
    })).resolves.toEqual({
      kind: 'multipart',
      parts: [
        { kind: 'text', name: 'purpose', value: 'file-extract' },
        {
          kind: 'file', name: 'file', fileName: 'image.png',
          contentType: 'image/png', bytesBase64: 'AQID',
        },
      ],
    })
  })

  it('rejects malformed JSON and method/path/body mismatches', async () => {
    await expect(encodeProviderWireBody({
      target: {
        provider: 'deepseek', scope: 'default', method: 'POST', path: '/chat/completions',
      },
      body: { kind: 'json', json: 'not-json' },
    })).rejects.toThrow('模型请求格式无效')
    await expect(encodeProviderWireBody({
      target: uploadTarget,
      body: { kind: 'none' },
    } as ProviderTransportInput)).rejects.toThrow('模型请求格式无效')
  })

  it('rejects unsafe metadata and unsupported provider scopes', async () => {
    await expect(encodeProviderWireBody({
      target: uploadTarget,
      body: {
        kind: 'multipart',
        parts: [{
          kind: 'file', name: '../file', fileName: 'a.png', contentType: 'image/png',
          data: new Blob([Uint8Array.of(1)]),
        }],
      },
    })).rejects.toThrow('模型请求格式无效')
    const globalTarget = {
      provider: 'kimi', scope: 'default', method: 'POST', path: '/chat/completions',
    } as unknown as ProviderTarget
    await expect(encodeProviderWireBody({
      target: globalTarget, body: { kind: 'json', json: '{}' },
    })).rejects.toThrow('模型请求目标未获允许')
  })

  it('honors an already-aborted signal before reading blobs', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(encodeProviderWireBody({
      target: uploadTarget,
      body: {
        kind: 'multipart',
        parts: [{
          kind: 'file', name: 'file', fileName: 'a.png', contentType: 'image/png',
          data: new Blob([Uint8Array.of(1)]),
        }],
      },
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
