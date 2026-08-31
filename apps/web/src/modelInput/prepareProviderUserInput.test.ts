import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareProviderUserInput } from './prepareProviderUserInput'

const signal = new AbortController().signal

describe('provider user input preparation', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_KIMI_IMAGE_INPUT_ENABLED', 'true')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps pure text provider-neutral and performs no transport request', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const prepared = await prepareProviderUserInput(
      { text: 'hello' },
      {
        sessionId: 'session-1',
        settings: { vendor: 'deepseek', model: 'deepseek-chat' },
        apiKey: 'managed',
        signal,
        fetchImpl,
      },
    )
    expect(prepared.content).toBe('hello')
    expect(prepared.rollback).toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('delegates Kimi files to its adapter and exposes adapter rollback to Core', async () => {
    const methods: string[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      methods.push(init?.method ?? 'POST')
      return init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ id: 'file-one' }), { status: 200 })
    })
    const file = new File(['png-data'], 'one.png', { type: 'image/png' })
    const prepared = await prepareProviderUserInput(
      {
        text: '看看这张图',
        images: [{
          id: 'draft-1',
          name: file.name,
          mimeType: file.type,
          byteSize: file.size,
          width: 20,
          height: 10,
          data: file,
        }],
      },
      {
        sessionId: 'session-1',
        settings: { vendor: 'kimi', model: 'kimi-k3', vendorSettings: { region: 'cn' } },
        apiKey: 'managed',
        signal,
        fetchImpl,
      },
    )

    expect(prepared.content).toEqual([
      { type: 'text', text: '看看这张图' },
      expect.objectContaining({
        type: 'image',
        source: { kind: 'provider-file', provider: 'kimi', scope: 'kimi:cn', reference: 'ms://file-one' },
      }),
    ])
    await prepared.rollback?.('settings_changed')
    expect(methods).toEqual(['POST', 'DELETE'])
  })

  it('uploads original Composer images through the DeepSeek vision adapter', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => init?.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ id: 'file-api-one' }), { status: 200 }))
    const file = new File(['original-png-data'], 'one.png', { type: 'image/png' })
    const prepared = await prepareProviderUserInput(
      {
        text: '看看这张图',
        images: [{
          id: 'draft-1',
          name: file.name,
          mimeType: file.type,
          byteSize: file.size,
          width: 20,
          height: 10,
          data: file,
        }],
      },
      {
        sessionId: 'session-1',
        settings: { vendor: 'deepseek', model: 'deepseek-v4-flash-vision-exp' },
        apiKey: 'managed',
        signal,
        fetchImpl,
      },
    )

    const [url, init] = fetchImpl.mock.calls[0]
    const body = init?.body as FormData
    expect(url).toBe('https://api.deepseek.com/files')
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer managed' } })
    expect(body.get('purpose')).toBe('user_data')
    expect(body.get('file')).toBeInstanceOf(File)
    expect(body.get('file')).toMatchObject({ name: file.name, size: file.size, type: file.type })
    expect(prepared.content).toEqual([
      { type: 'text', text: '看看这张图' },
      expect.objectContaining({
        type: 'image',
        source: {
          kind: 'provider-file',
          provider: 'deepseek',
          scope: 'deepseek:default',
          reference: 'file-api-one',
        },
      }),
    ])
    await prepared.rollback?.('settings_changed')
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://api.deepseek.com/files/file-api-one',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('rejects images for an unverified model before transport', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const file = new File(['png-data'], 'one.png', { type: 'image/png' })
    await expect(prepareProviderUserInput(
      {
        text: '',
        images: [{
          id: 'draft-1',
          name: file.name,
          mimeType: file.type,
          byteSize: file.size,
          data: file,
        }],
      },
      {
        sessionId: 'session-1',
        settings: { vendor: 'kimi', model: 'unknown-kimi', vendorSettings: { region: 'cn' } },
        apiKey: 'managed',
        signal,
        fetchImpl,
      },
    )).rejects.toThrow('no verified image input protocol')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('enforces the public Kimi image gate before adapter transport', async () => {
    vi.stubEnv('VITE_KIMI_IMAGE_INPUT_ENABLED', 'false')
    const fetchImpl = vi.fn<typeof fetch>()
    const file = new File(['png-data'], 'one.png', { type: 'image/png' })
    await expect(prepareProviderUserInput(
      {
        text: '',
        images: [{
          id: 'draft-1',
          name: file.name,
          mimeType: file.type,
          byteSize: file.size,
          data: file,
        }],
      },
      {
        sessionId: 'session-1',
        settings: { vendor: 'kimi', model: 'kimi-k3', vendorSettings: { region: 'cn' } },
        apiKey: 'managed',
        signal,
        fetchImpl,
      },
    )).rejects.toThrow('Kimi 图片输入尚未开放')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
