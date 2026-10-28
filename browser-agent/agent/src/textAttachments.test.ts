import { describe, expect, it } from 'vitest'
import { addTextAttachments, prepareTextAttachments, restoreTextAttachmentDraft } from './textAttachments'

const context = () => ({ sessionId: 's', settings: { vendor: 'openai-compat', model: 'test' }, apiKey: '', signal: new AbortController().signal })

describe('local text attachment preparation', () => {
  it('preserves file text separately from the prompt and reconstructs an undo draft', async () => {
    const files = addTextAttachments([], [new File(['城市,数量\r\n上海,12'], '数据.csv', { type: 'text/csv' })])
    const prepared = await prepareTextAttachments({ text: '填写表单', files }, context())
    expect(prepared.content).toEqual([
      { type: 'text', text: '填写表单' },
      { type: 'text', text: '城市,数量\r\n上海,12', attachment: { name: '数据.csv', mimeType: 'text/csv', byteSize: files[0].byteSize } },
    ])
    const restored = restoreTextAttachmentDraft(prepared.content)
    expect(restored.text).toBe('填写表单')
    expect(restored.files[0].name).toBe('数据.csv')
    expect((await prepareTextAttachments({ text: restored.text, files: restored.files }, context())).content).toEqual(prepared.content)
  })

  it('reads UTF-16 CSV with a BOM and rejects corrupt or disguised binary files', async () => {
    const file = (data: BlobPart) => addTextAttachments([], [new File([data], '表.csv')])
    expect((await prepareTextAttachments({ text: '', files: file(new Uint8Array([255, 254, 65, 0, 44, 0, 66, 0])) }, context())).content).toEqual([
      { type: 'text', text: 'A,B', attachment: { name: '表.csv', mimeType: 'text/plain', byteSize: 8 } },
    ])
    await expect(prepareTextAttachments({ text: '', files: file(new Uint8Array([128, 129])) }, context())).rejects.toThrow('UTF-8')
    await expect(prepareTextAttachments({ text: '', files: file('abc\0def') }, context())).rejects.toThrow('二进制')
    await expect(prepareTextAttachments({ text: '', files: file(' \n ') }, context())).rejects.toThrow('没有可读取')
  })

  it('enforces type, size, count and context limits without silently truncating', async () => {
    expect(() => addTextAttachments([], [new File(['docx'], '说明.docx')])).toThrow('暂不支持')
    expect(() => addTextAttachments([], [new File([], '空.txt')])).toThrow('空文件')
    expect(() => addTextAttachments([], [new File(['a'.repeat(262145)], '大.txt')])).toThrow('256 KB')
    expect(() => addTextAttachments([], Array.from({ length: 7 }, () => new File(['a'], 'a.txt')))).toThrow('6 个')
    const files = addTextAttachments([], [new File(['a'.repeat(100001)], '超长.txt')])
    await expect(prepareTextAttachments({ text: '', files }, context())).rejects.toThrow('10 万字符')
    const aborted = context()
    aborted.signal = AbortSignal.abort()
    await expect(prepareTextAttachments({ text: '', files }, aborted)).rejects.toHaveProperty('name', 'AbortError')
  })

  it('can resend a valid UTF-16 attachment after undo even if its UTF-8 encoding is larger', async () => {
    const text = '中'.repeat(90_000)
    const content = [{ type: 'text' as const, text, attachment: { name: '数据.txt', mimeType: 'text/plain', byteSize: 180002 } }]
    const draft = restoreTextAttachmentDraft(content)
    expect(draft.files[0].byteSize).toBe(180002)
    expect((await prepareTextAttachments(draft, context())).content).toEqual(content)
  })
})
