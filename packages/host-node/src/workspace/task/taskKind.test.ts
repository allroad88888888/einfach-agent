import { describe, expect, it } from 'vitest'
import { packageScriptForKind, parseTaskKind } from './taskKind'

describe('parseTaskKind', () => {
  it.each(['test', 'build', 'lint', 'typecheck', 'cargo_check'] as const)(
    '接受合法 kind `%s`',
    (kind) => {
      expect(parseTaskKind(kind)).toBe(kind)
    },
  )

  it('拒绝非法 kind，消息逐字对齐 Rust', () => {
    expect(() => parseTaskKind('deploy')).toThrow(
      'unsupported task kind `deploy`; expected `test`, `build`, `lint`, `typecheck`, or `cargo_check`',
    )
  })

  it('空字符串同样是非法 kind（不是「未传」的特殊情况）', () => {
    expect(() => parseTaskKind('')).toThrow('unsupported task kind ``')
  })
})

describe('packageScriptForKind', () => {
  it('四个 package-script kind 的脚本名与 kind 本身相同', () => {
    expect(packageScriptForKind('test')).toBe('test')
    expect(packageScriptForKind('build')).toBe('build')
    expect(packageScriptForKind('lint')).toBe('lint')
    expect(packageScriptForKind('typecheck')).toBe('typecheck')
  })

  it('cargo_check 不映射到任何 script', () => {
    expect(packageScriptForKind('cargo_check')).toBeUndefined()
  })
})
