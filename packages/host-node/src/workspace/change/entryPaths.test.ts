import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { entryPath, payloadPath, validateChangeId } from './entryPaths'

describe('validateChangeId', () => {
  it.each(['abc', 'ABC123', 'a-b_c', '0', 'change-1755000000000-abcdef'])(
    '接受 %s',
    (changeId) => {
      expect(() => validateChangeId(changeId)).not.toThrow()
    },
  )

  it.each([
    ['空串', ''],
    ['路径分隔符', 'a/b'],
    ['Windows 分隔符', 'a\\b'],
    ['父目录', '..'],
    ['带点（会与 .json 后缀混淆）', 'a.json'],
    ['空格', 'a b'],
    ['非 ASCII', 'ä'],
    ['中文', '账'],
    ['NUL 字节', 'a\u0000b'],
  ])('拒绝 %s', (_name, changeId) => {
    // 每一条都是「日志条目写到日志目录外面去」的入口：id 是调用方给的字符串，会被原样拼进路径。
    expect(() => validateChangeId(changeId)).toThrow('invalid workspace change id')
  })
})

describe('entryPath / payloadPath', () => {
  it('条目是 <id>.json，载荷是 <id>.payload，同住日志目录', () => {
    expect(entryPath('/journal', 'abc')).toBe(join('/journal', 'abc.json'))
    expect(payloadPath('/journal', 'abc')).toBe(join('/journal', 'abc.payload'))
  })

  it('两者永不同名（否则可恢复删除会用载荷盖掉自己的账）', () => {
    expect(entryPath('/journal', 'abc')).not.toBe(payloadPath('/journal', 'abc'))
  })
})
