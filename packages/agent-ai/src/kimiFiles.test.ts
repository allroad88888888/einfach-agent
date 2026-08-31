import { describe, expect, it, vi } from 'vitest'
import {
  prepareKimiImageBatch,
  prepareKimiImages,
  type KimiLocalImage,
} from './kimiFiles'

function image(name: string, content = name): KimiLocalImage {
  return {
    data: new Blob([content], { type: 'image/png' }),
    name,
    mimeType: 'image/png',
    width: 100,
    height: 50,
  }
}

function formFile(init?: RequestInit): File {
  const form = init?.body as FormData
  expect(form).toBeInstanceOf(FormData)
  expect(form.get('purpose')).toBe('image')
  return form.get('file') as File
}

describe('Kimi image preparation', () => {
  it('uploads multipart images concurrently and restores selection order', async () => {
    const completionOrder: string[] = []
    const urls: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      urls.push(String(input))
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret')
      expect(new Headers(init?.headers).has('Content-Type')).toBe(false)
      const file = formFile(init)
      const delay = file.name === 'first.png' ? 10 : 0
      await new Promise((resolve) => setTimeout(resolve, delay))
      completionOrder.push(file.name)
      return new Response(JSON.stringify({ id: `id-${file.name.replace('.png', '')}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const blocks = await prepareKimiImages(
      [image('first.png'), image('second.png')],
      { apiKey: 'secret', region: 'cn', fetchImpl },
    )

    expect(completionOrder).toEqual(['second.png', 'first.png'])
    expect(urls).toEqual([
      'https://api.moonshot.cn/v1/files',
      'https://api.moonshot.cn/v1/files',
    ])
    expect(blocks.map((block) => block.source.reference)).toEqual([
      'ms://id-first',
      'ms://id-second',
    ])
    expect(blocks[0]).toMatchObject({
      source: { provider: 'kimi', scope: 'kimi:cn' },
      name: 'first.png',
      mimeType: 'image/png',
      byteSize: 9,
      width: 100,
      height: 50,
    })
  })

  it('cleans every successful upload after a partial failure without leaking details', async () => {
    const deleted: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      if (init?.method === 'DELETE') {
        deleted.push(url)
        throw new Error('cleanup remote secret')
      }
      const file = formFile(init)
      if (file.name === 'broken.png') {
        return new Response('remote body secret', { status: 503 })
      }
      return new Response(JSON.stringify({ id: `private-${file.name.replace('.png', '')}` }), {
        status: 200,
      })
    }

    const pending = prepareKimiImages(
      [image('one.png'), image('broken.png'), image('three.png')],
      { apiKey: 'secret', region: 'cn', fetchImpl },
    )
    await expect(pending).rejects.toThrow('Kimi image upload failed with HTTP 503.')
    await expect(pending).rejects.not.toThrow(/remote body secret|private-/)
    expect(deleted).toEqual([
      'https://api.moonshot.cn/v1/files/private-one',
      'https://api.moonshot.cn/v1/files/private-three',
    ])
  })

  it('aborts pending uploads but still cleans files that already succeeded', async () => {
    const controller = new AbortController()
    const deleted: string[] = []
    let markPendingStarted!: () => void
    const pendingStarted = new Promise<void>((resolve) => { markPendingStarted = resolve })
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === 'DELETE') {
        deleted.push(String(input))
        return new Response(null, { status: 204 })
      }
      const file = formFile(init)
      if (file.name === 'done.png') {
        return new Response(JSON.stringify({ id: 'finished-file' }), { status: 200 })
      }
      markPendingStarted()
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }

    const pending = prepareKimiImages(
      [image('done.png'), image('waiting.png')],
      { apiKey: 'secret', region: 'cn', signal: controller.signal, fetchImpl },
    )
    await pendingStarted
    controller.abort(new DOMException('stopped', 'AbortError'))

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(deleted).toEqual(['https://api.moonshot.cn/v1/files/finished-file'])
  })

  it('deletes a completed K3 batch at most once after explicit rollback', async () => {
    const methods: string[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      methods.push(init?.method ?? 'POST')
      return init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ id: 'k3-file' }), { status: 200 })
    })
    const batch = await prepareKimiImageBatch(
      [image('one.png')],
      { apiKey: 'key', region: 'cn', fetchImpl },
    )

    expect(batch.blocks[0]?.source).toMatchObject({
      scope: 'kimi:cn', reference: 'ms://k3-file',
    })
    await batch.rollback()
    await batch.rollback()

    expect(methods).toEqual(['POST', 'DELETE'])
  })

  it('rejects invalid responses and batches before exposing any result', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ id: '../unsafe-id' }),
      { status: 200 },
    ))
    await expect(prepareKimiImages(
      [image('one.png')],
      { apiKey: 'key', region: 'cn', fetchImpl },
    )).rejects.toThrow('invalid file id')
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.moonshot.cn/v1/files',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('rejects global image preparation before transport until disposal is supported', async () => {
    const fetchImpl = vi.fn<typeof fetch>()

    await expect(prepareKimiImages(
      [image('one.png')],
      { apiKey: 'key', region: 'global', fetchImpl },
    )).rejects.toThrow('limited to the cn region')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('cannot override the adapter-owned CN origin', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ id: 'official-origin' }),
      { status: 200 },
    ))
    const unsafeOptions = {
      apiKey: 'key',
      region: 'cn' as const,
      baseUrl: 'https://untrusted.example/v1',
      fetchImpl,
    }

    await prepareKimiImages([image('one.png')], unsafeOptions)

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.moonshot.cn/v1/files',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('does not expose malformed remote response bodies', async () => {
    const fetchImpl: typeof fetch = async () => new Response(
      'private remote response body',
      { status: 200 },
    )
    const pending = prepareKimiImages(
      [image('one.png')],
      { apiKey: 'key', region: 'cn', fetchImpl },
    )
    await expect(pending).rejects.toThrow('returned invalid JSON')
    await expect(pending).rejects.not.toThrow('private remote response body')
  })

  it('does not expose thrown transport details', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('Bearer sk-secret ms://private-file')
    }
    const pending = prepareKimiImages(
      [image('one.png')],
      { apiKey: 'key', region: 'cn', fetchImpl },
    )

    await expect(pending).rejects.toThrow('Kimi image upload transport failed')
    await expect(pending).rejects.not.toThrow(/Bearer|sk-secret|ms:\/\//)
  })

  it('validates MIME type before transport', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    await expect(prepareKimiImages(
      [{ ...image('bad.svg'), mimeType: 'image/svg+xml' }],
      { apiKey: 'key', region: 'cn', fetchImpl },
    )).rejects.toThrow('does not accept image type')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
