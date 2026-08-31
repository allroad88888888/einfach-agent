import { describe, expect, it, vi } from 'vitest'
import {
  prepareDeepSeekImageBatch,
  type DeepSeekLocalImage,
} from './deepseekFiles'

function image(name: string, content = name): DeepSeekLocalImage {
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
  expect(form.get('purpose')).toBe('user_data')
  return form.get('file') as File
}

describe('DeepSeek image batch upload', () => {
  it('uploads official multipart fields concurrently and restores selection order', async () => {
    const completionOrder: string[] = []
    const urls: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      urls.push(String(input))
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret')
      expect(new Headers(init?.headers).has('Content-Type')).toBe(false)
      const file = formFile(init)
      if (file.name === 'first.png') await new Promise((resolve) => setTimeout(resolve, 10))
      completionOrder.push(file.name)
      return new Response(JSON.stringify({
        id: `file-api-${file.name.replace('.png', '')}`,
      }), { status: 200 })
    }

    const batch = await prepareDeepSeekImageBatch(
      [image('first.png'), image('second.png')],
      { apiKey: 'secret', fetchImpl },
    )

    expect(completionOrder).toEqual(['second.png', 'first.png'])
    expect(urls).toEqual(['https://api.deepseek.com/files', 'https://api.deepseek.com/files'])
    expect(batch.blocks.map((block) => block.source.reference)).toEqual([
      'file-api-first',
      'file-api-second',
    ])
    expect(batch.blocks[0]).toMatchObject({
      source: { provider: 'deepseek', scope: 'deepseek:default' },
      name: 'first.png',
      mimeType: 'image/png',
      byteSize: 9,
      width: 100,
      height: 50,
    })
  })

  it('rolls a completed batch back once, independently of the upload signal', async () => {
    const deleted: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === 'DELETE') {
        expect(init.signal).toBeUndefined()
        deleted.push(String(input))
        return new Response(null, { status: 204 })
      }
      return new Response(JSON.stringify({ id: 'file-api-rollback' }), { status: 200 })
    }
    const batch = await prepareDeepSeekImageBatch([image('one.png')], {
      apiKey: 'secret',
      fetchImpl,
    })

    await batch.rollback()
    await batch.rollback()

    expect(deleted).toEqual(['https://api.deepseek.com/files/file-api-rollback'])
  })

  it('cleans every successful upload after a partial failure without leaking details', async () => {
    const deleted: string[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      if (init?.method === 'DELETE') {
        deleted.push(String(input))
        throw new Error('cleanup remote secret')
      }
      const file = formFile(init)
      if (file.name === 'broken.png') return new Response('remote secret', { status: 503 })
      return new Response(JSON.stringify({
        id: `file-api-${file.name.replace('.png', '')}`,
      }), { status: 200 })
    }

    const pending = prepareDeepSeekImageBatch(
      [image('one.png'), image('broken.png'), image('three.png')],
      { apiKey: 'secret', fetchImpl },
    )

    await expect(pending).rejects.toThrow('DeepSeek image upload failed with HTTP 503.')
    await expect(pending).rejects.not.toThrow(/remote secret|file-api-one/)
    expect(deleted).toEqual([
      'https://api.deepseek.com/files/file-api-one',
      'https://api.deepseek.com/files/file-api-three',
    ])
  })

  it('aborts pending uploads and cleans files that already succeeded', async () => {
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
        return new Response(JSON.stringify({ id: 'file-api-finished' }), { status: 200 })
      }
      markPendingStarted()
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }

    const pending = prepareDeepSeekImageBatch(
      [image('done.png'), image('waiting.png')],
      { apiKey: 'secret', signal: controller.signal, fetchImpl },
    )
    await pendingStarted
    controller.abort(new DOMException('stopped', 'AbortError'))

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(deleted).toEqual(['https://api.deepseek.com/files/file-api-finished'])
  })

  it('rejects invalid ids, unsupported MIME, and origin override attempts', async () => {
    const invalidFetch = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ id: 'ms://not-deepseek' }),
      { status: 200 },
    ))
    await expect(prepareDeepSeekImageBatch([image('one.png')], {
      apiKey: 'key',
      fetchImpl: invalidFetch,
    })).rejects.toThrow('invalid file id')

    const unusedFetch = vi.fn<typeof fetch>()
    await expect(prepareDeepSeekImageBatch(
      [{ ...image('bad.svg'), mimeType: 'image/svg+xml' }],
      { apiKey: 'key', fetchImpl: unusedFetch },
    )).rejects.toThrow('does not accept image type')
    expect(unusedFetch).not.toHaveBeenCalled()

    const officialFetch = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ id: 'file-api-official' }),
      { status: 200 },
    ))
    await prepareDeepSeekImageBatch([image('one.png')], {
      apiKey: 'key',
      fetchImpl: officialFetch,
      baseUrl: 'https://untrusted.example',
    } as Parameters<typeof prepareDeepSeekImageBatch>[1] & { baseUrl: string })
    expect(officialFetch).toHaveBeenCalledWith(
      'https://api.deepseek.com/files',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
