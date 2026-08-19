import { describe, expect, it } from 'vitest'
import { narrowProviderRequestBody, prepareProviderBody } from './requestBody'

function prepare(value: unknown, expected: 'none' | 'json' | 'multipart') {
  return prepareProviderBody(narrowProviderRequestBody(value), expected)
}

function textPart(name: string, value: string) {
  return { kind: 'text', name, value }
}

function filePart(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'file',
    name: 'file',
    fileName: 'a.png',
    contentType: 'image/png',
    bytesBase64: 'AQID',
    ...overrides,
  }
}

describe('body 形状与端点必须匹配', () => {
  it('三种 kind 各自只配得上对应的端点', () => {
    expect(prepare({ kind: 'none' }, 'none')).toEqual({ kind: 'none' })
    expect(prepare({ kind: 'json', json: '{}' }, 'json')).toEqual({ kind: 'json', json: '{}' })
    // 往 /chat/completions 发 multipart、往 /files 发 json 都是格式无效：端点的 body 形状是
    // 策略的一部分，不是「能装下就行」。
    expect(() => prepare({ kind: 'none' }, 'json')).toThrow('模型请求格式无效')
    expect(() => prepare({ kind: 'json', json: '{}' }, 'multipart')).toThrow('模型请求格式无效')
    expect(() => prepare({ kind: 'multipart', parts: [textPart('a', 'b')] }, 'json')).toThrow(
      '模型请求格式无效',
    )
  })

  it('JSON 必须真的是 JSON，且原文逐字透传', () => {
    // 原文透传是刻意的：重新序列化会动字段顺序与数字表示，而那份 body 是 adapter 精确构造的。
    const json = '{"model":"x","temperature":1.0,"messages":[]}'
    expect(prepare({ kind: 'json', json }, 'json')).toEqual({ kind: 'json', json })
    expect(() => prepare({ kind: 'json', json: 'not-json' }, 'json')).toThrow('模型请求格式无效')
  })

  it('拒绝多余字段与未知 kind', () => {
    for (const value of [
      { kind: 'none', json: '{}' },
      { kind: 'json' },
      { kind: 'json', json: '{}', extra: 1 },
      { kind: 'multipart' },
      { kind: 'multipart', parts: {} },
      { kind: 'binary', bytes: 'AQID' },
      'json',
      null,
    ]) {
      expect(() => narrowProviderRequestBody(value)).toThrow('模型请求格式无效')
    }
  })
})

describe('multipart 的限额与判据', () => {
  it('分片数上下界', () => {
    expect(() => prepare({ kind: 'multipart', parts: [] }, 'multipart')).toThrow('模型请求格式无效')
    const seventeen = Array.from({ length: 17 }, (_, index) => textPart(`p${index}`, 'x'))
    expect(() => prepare({ kind: 'multipart', parts: seventeen }, 'multipart')).toThrow(
      '模型请求格式无效',
    )
  })

  it('分片名只收 ASCII 字母数字与下划线连字符', () => {
    for (const name of ['', '../file', 'a b', 'namé', 'a'.repeat(65)]) {
      expect(() => prepare({ kind: 'multipart', parts: [textPart(name, 'x')] }, 'multipart')).toThrow(
        '模型请求格式无效',
      )
    }
  })

  it('文件名不许带路径分隔符与控制字符', () => {
    // 控制字符两段都要挡：C0（U+0000–U+001F）与 C1（U+007F–U+009F）——文件名会原样进
    // Content-Disposition 头。正则与用例都写 \u 转义，不放字面控制字符：后者会让整份源文件
    // 被 grep 当成二进制、从此搜不到任何符号。
    const forbidden = ['', 'a/b.png', 'a\\b.png', 'a\u0000.png', 'a\u007f.png', 'a\u0085.png']
    for (const fileName of [...forbidden, 'a'.repeat(256)]) {
      expect(() =>
        prepare({ kind: 'multipart', parts: [filePart({ fileName })] }, 'multipart'),
      ).toThrow('模型请求格式无效')
    }
    // 空格与非 ASCII 是**合法**文件名，别顺手收严——那会拒掉桌面端能上传的文件。
    for (const fileName of ['a .png', '截图.png']) {
      expect(() =>
        prepare({ kind: 'multipart', parts: [filePart({ fileName })] }, 'multipart'),
      ).not.toThrow()
    }
  })

  it('content-type 必须是恰好两段的 token/token', () => {
    for (const contentType of ['', 'image', 'image/png/extra', 'image /png', 'imäge/png']) {
      expect(() =>
        prepare({ kind: 'multipart', parts: [filePart({ contentType })] }, 'multipart'),
      ).toThrow('模型请求格式无效')
    }
  })

  it('base64 走严格标准解码，不是 Buffer 的宽容解码', () => {
    // Buffer.from(x, 'base64') 会跳过表外字符、接受缺失补齐，于是下面这些全都能"解出字节"。
    // Rust 的 STANDARD 引擎一条都不收，Node 侧必须一致——否则同一份坏输入两个宿主给不同答案。
    // 'AR==' 是最阴的一条：长度、字母表、补齐全合规，只有尾部冗余比特不规范。Buffer 照解不误
    // （解出 [0x01]），base64 crate 拒收。「重新编码必须逐字相等」那道判据专门兜的就是它。
    for (const bytesBase64 of ['AQI', 'AQ ID', 'AQID!', 'AQID=', '****', 'AR==']) {
      expect(() =>
        prepare({ kind: 'multipart', parts: [filePart({ bytesBase64 })] }, 'multipart'),
      ).toThrow('模型请求格式无效')
    }
    const prepared = prepare({ kind: 'multipart', parts: [filePart()] }, 'multipart')
    expect(prepared).toEqual({
      kind: 'multipart',
      parts: [
        {
          kind: 'file',
          name: 'file',
          fileName: 'a.png',
          contentType: 'image/png',
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
    })
  })

  it('空文件不收（Rust 判的是解码后的字节数）', () => {
    expect(() => prepare({ kind: 'multipart', parts: [filePart({ bytesBase64: '' })] }, 'multipart'))
      .toThrow('模型请求格式无效')
  })

  it('文本分片按累计字节数封顶，不是按单片', () => {
    // 单片 64 KiB 合规、累计 256 KiB 封顶：五片 64 KiB 各自都合规，加起来越界。
    const chunk = 'x'.repeat(64 * 1024)
    const parts = Array.from({ length: 5 }, (_, index) => textPart(`p${index}`, chunk))
    expect(() => prepare({ kind: 'multipart', parts }, 'multipart')).toThrow('模型请求格式无效')
    expect(() =>
      prepare({ kind: 'multipart', parts: parts.slice(0, 4) }, 'multipart'),
    ).not.toThrow()
  })

  it('文件数封顶在 8', () => {
    const nine = Array.from({ length: 9 }, (_, index) => filePart({ name: `f${index}` }))
    expect(() => prepare({ kind: 'multipart', parts: nine }, 'multipart')).toThrow(
      '模型请求格式无效',
    )
  })
})
