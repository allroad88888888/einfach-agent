import { describe, expect, it } from 'vitest'
import { parseFrontmatter } from './projectSkills'

describe('parseFrontmatter', () => {
  it('空字符串 → 所有字段默认值', () => {
    const fm = parseFrontmatter('')
    expect(fm.name).toBeUndefined()
    expect(fm.description).toBeUndefined()
    expect(fm.triggers).toBeUndefined()
    expect(fm.unknownKeys).toEqual([])
  })

  it('不以 --- 开头的文本 → 所有字段默认值', () => {
    const fm = parseFrontmatter('hello world')
    expect(fm.name).toBeUndefined()
    expect(fm.description).toBeUndefined()
    expect(fm.unknownKeys).toEqual([])
  })

  it('标准 frontmatter 三项齐全', () => {
    const raw = [
      '---',
      'name: deploy-flow',
      'description: 何时用：改发布脚本；何时不用：普通改动',
      'triggers: [deploy, 发布, 上线]',
      '---',
      '',
      '# 正文开始',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBe('deploy-flow')
    expect(fm.description).toBe('何时用：改发布脚本；何时不用：普通改动')
    expect(fm.triggers).toEqual(['deploy', '发布', '上线'])
    expect(fm.unknownKeys).toEqual([])
  })

  it('name 来自 frontmatter（覆盖目录名）', () => {
    const raw = [
      '---',
      'name: custom-name',
      '---',
      '',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBe('custom-name')
  })

  it('name 缺失 → undefined', () => {
    const raw = [
      '---',
      'description: 只有描述',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBeUndefined()
    expect(fm.description).toBe('只有描述')
  })

  it('description 缺失 → undefined', () => {
    const raw = [
      '---',
      'name: some-skill',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBe('some-skill')
    expect(fm.description).toBeUndefined()
  })

  it('triggers 空数组', () => {
    const raw = [
      '---',
      'name: no-triggers',
      'description: 无触发词',
      'triggers: []',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.triggers).toEqual([])
  })

  it('triggers 缺失 → undefined', () => {
    const raw = [
      '---',
      'name: no-triggers',
      'description: 无触发词',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.triggers).toBeUndefined()
  })

  it('未知键 → 记录到 unknownKeys', () => {
    const raw = [
      '---',
      'name: test',
      'description: desc',
      'version: 1.0',
      'author: someone',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.unknownKeys).toEqual(['version', 'author'])
  })

  it('语法不合法的行 → 记录到 unknownKeys', () => {
    const raw = [
      '---',
      'no colon here',
      'name: test',
      'description: desc',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBe('test')
    expect(fm.description).toBe('desc')
    expect(fm.unknownKeys).toContain('(malformed line) no colon here')
  })

  it('只识别开头的 frontmatter，正文中的 --- 不被识别为结束', () => {
    const raw = [
      '---',
      'name: test',
      'description: desc',
      '---',
      '',
      '# 正文',
      '正文中有一段 --- 但不是围栏',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBe('test')
    expect(fm.description).toBe('desc')
  })

  it('有开头围栏但无结束围栏 → 所有字段默认值', () => {
    const raw = [
      '---',
      'name: ghost-skill',
      'description: missing closing fence',
      '',
      '# no --- ahead',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBeUndefined()
    expect(fm.description).toBeUndefined()
    expect(fm.unknownKeys).toEqual([])
  })

  it('description 用双引号包裹', () => {
    const raw = [
      '---',
      'name: quoted',
      'description: "包含: 特殊字符"',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.description).toBe('包含: 特殊字符')
  })

  it('description 用单引号包裹', () => {
    const raw = [
      '---',
      "name: quoted",
      "description: '包含: 特殊字符'",
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.description).toBe('包含: 特殊字符')
  })

  it('triggers 数组中含引号包裹的项', () => {
    const raw = [
      '---',
      'name: test',
      'description: desc',
      'triggers: ["deploy", \'发布\', simple]',
      '---',
    ].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.triggers).toEqual(['deploy', '发布', 'simple'])
  })

  it('CRLF 换行符', () => {
    const raw = '---\r\nname: crlf\r\ndescription: with crlf\r\n---\r\n'
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBe('crlf')
    expect(fm.description).toBe('with crlf')
  })

  it('空 frontmatter（两个紧邻的 ---）', () => {
    const raw = ['---', '---', ''].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.name).toBeUndefined()
    expect(fm.description).toBeUndefined()
    expect(fm.triggers).toBeUndefined()
    expect(fm.unknownKeys).toEqual([])
  })

  it('description 含有注释（# 之后被忽略）', () => {
    const raw = ['---', 'description: 有用描述 # 这是注释', '---', ''].join('\n')
    const fm = parseFrontmatter(raw)
    expect(fm.description).toBe('有用描述')
  })
})
