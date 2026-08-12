import { describe, expect, it } from 'vitest'
import { sanitizeDescription, sanitizeName } from './projectSkills'

describe('sanitizeName', () => {
  it('合法小写字母+数字+短横线', () => {
    expect(sanitizeName('deploy-flow')).toBe('deploy-flow')
    expect(sanitizeName('test123')).toBe('test123')
    expect(sanitizeName('a')).toBe('a')
  })

  it('自动转小写', () => {
    expect(sanitizeName('Deploy-Flow')).toBe('deploy-flow')
  })

  it('trim 前后空格', () => {
    expect(sanitizeName('  my-skill  ')).toBe('my-skill')
  })

  it('非法：含下划线 → undefined', () => {
    expect(sanitizeName('deploy_flow')).toBeUndefined()
  })

  it('非法：含点 → undefined', () => {
    expect(sanitizeName('deploy.flow')).toBeUndefined()
  })

  it('非法：含空格 → undefined', () => {
    expect(sanitizeName('deploy flow')).toBeUndefined()
  })

  it('非法：以短横线开头 → undefined', () => {
    expect(sanitizeName('-start')).toBeUndefined()
  })

  it('非法：空字符串 → undefined', () => {
    expect(sanitizeName('')).toBeUndefined()
  })

  it('非法：超过 64 字符 → undefined', () => {
    expect(sanitizeName('a'.repeat(65))).toBeUndefined()
  })

  it('边界：正好 64 字符 → 合法', () => {
    expect(sanitizeName('a'.repeat(64))).toBe('a'.repeat(64))
  })
})

// ===========================================================================
// sanitizeDescription
// ===========================================================================

describe('sanitizeDescription', () => {
  it('正常描述原样返回，不标记截断', () => {
    const desc = '何时用：改发布脚本时读我；何时不用：普通改动'
    expect(sanitizeDescription(desc)).toEqual({ value: desc, truncated: false })
  })

  it('剥离控制字符', () => {
    expect(sanitizeDescription('hello\x00world')?.value).toBe('helloworld')
    expect(sanitizeDescription('test\x1Bcontrol')?.value).toBe('testcontrol')
    expect(sanitizeDescription('normal\x7Fdel')?.value).toBe('normaldel')
  })

  it('多行 → 只取第一行', () => {
    const desc = '第一行描述\n第二行不应该出现\n第三行'
    expect(sanitizeDescription(desc)?.value).toBe('第一行描述')
  })

  it('超长 → 截断到 160 字符并追加省略号 + 标记 truncated', () => {
    const long = 'x'.repeat(200)
    const result = sanitizeDescription(long)
    // 省略号是给模型的信号：这句话没说完，别把它当完整约束读
    expect(result).toEqual({ value: `${'x'.repeat(160)}…`, truncated: true })
  })

  it('边界：正好 160 字符 → 原样返回，不加省略号', () => {
    const exact = 'x'.repeat(160)
    expect(sanitizeDescription(exact)).toEqual({ value: exact, truncated: false })
  })

  it('卫生化后为空 → undefined', () => {
    expect(sanitizeDescription('')).toBeUndefined()
    expect(sanitizeDescription('   ')).toBeUndefined()
    expect(sanitizeDescription('\n\n')).toBeUndefined()
  })

  it('只有控制字符 → undefined', () => {
    expect(sanitizeDescription('\x00\x01\x02')).toBeUndefined()
  })

  it('保留中文、标点与常见符号', () => {
    const desc = '何时用：发布/上线/CI 相关时读我；何时不用：普通编辑。'
    expect(sanitizeDescription(desc)?.value).toBe(desc)
  })
})
