import { describe, expect, it, vi } from 'vitest'
import { prepareKimiImageBatch } from './kimiFiles'

describe('Kimi prepared image transaction', () => {
  it('deletes uploaded files at most once when Core rolls the batch back', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      return new Response(JSON.stringify({ id: 'uploaded-id' }), { status: 200 })
    })
    const batch = await prepareKimiImageBatch([{
      data: new Blob(['image'], { type: 'image/png' }),
      name: 'draft.png',
      mimeType: 'image/png',
      width: 12,
      height: 8,
    }], { apiKey: 'secret', region: 'cn', fetchImpl })

    expect(batch.blocks[0]?.source.reference).toBe('ms://uploaded-id')
    await batch.rollback()
    await batch.rollback()

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://api.moonshot.cn/v1/files/uploaded-id',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})
