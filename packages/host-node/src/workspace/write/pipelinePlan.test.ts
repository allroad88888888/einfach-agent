import { describe, expect, it } from 'vitest'
import {
  computeAfterText,
  rejectImpossibleMode,
  resolveEffectiveMode,
  reversibleReason,
  summarizeChange,
  verifyGuard,
} from './pipelinePlan'
import { REVERSIBLE_MAX_BYTES } from './limits'
import { WriteRejection } from './result'
import type { BeforeContent } from './before'

const MISSING: BeforeContent = { kind: 'missing' }
const text = (value: string): BeforeContent => ({ kind: 'text', text: value })
const unsupported = (reason: string): BeforeContent => ({ kind: 'unsupported', reason })

function rejectionOf(run: () => void): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(WriteRejection)
    return (error as Error).message
  }
  throw new Error('应当被拒绝，但通过了')
}

describe('resolveEffectiveMode', () => {
  it('upsert 只看文件在不在：在就覆盖、不在就新建', () => {
    expect(resolveEffectiveMode('upsert', true)).toBe('overwrite')
    expect(resolveEffectiveMode('upsert', false)).toBe('create')
  })

  it('其余三种模式原样通过', () => {
    expect(resolveEffectiveMode('create', true)).toBe('create')
    expect(resolveEffectiveMode('overwrite', true)).toBe('overwrite')
    expect(resolveEffectiveMode('append', false)).toBe('append')
  })
})

describe('rejectImpossibleMode', () => {
  it('overwrite 一个不存在的文件被拒，并指出出路是 upsert', () => {
    const message = rejectionOf(() => rejectImpossibleMode('overwrite', false))
    expect(message).toBe(
      'cannot overwrite a file that does not exist; use mode "upsert" to create it when absent',
    )
  })

  it('文件存在时 overwrite 正常，其它模式一律不拦', () => {
    expect(() => rejectImpossibleMode('overwrite', true)).not.toThrow()
    expect(() => rejectImpossibleMode('create', false)).not.toThrow()
    expect(() => rejectImpossibleMode('append', false)).not.toThrow()
  })
})

describe('verifyGuard', () => {
  it('覆盖时正常校验守卫', () => {
    expect(() => verifyGuard(text('old'), 'overwrite', true, 'old', undefined)).not.toThrow()
    expect(rejectionOf(() => verifyGuard(text('old'), 'overwrite', true, 'stale', undefined))).toContain(
      'expectedOldContent does not match',
    )
  })

  it('追加到已存在的文件同样校验——分块重试时它是「上次写丢没丢」的唯一判据', () => {
    expect(rejectionOf(() => verifyGuard(text('one\n'), 'append', true, 'stale', undefined))).toContain(
      'expectedOldContent does not match',
    )
  })

  it('文件不存在却给了守卫 → 拒绝静默新建', () => {
    const message = rejectionOf(() => verifyGuard(MISSING, 'create', false, 'expected old', undefined))
    expect(message).toBe(
      'optimistic guard was provided but the file does not exist; drop the guard to create it',
    )
  })

  it('文件不存在且没给守卫 → 什么都不做', () => {
    expect(() => verifyGuard(MISSING, 'create', false, undefined, undefined)).not.toThrow()
    expect(() => verifyGuard(MISSING, 'append', false, undefined, undefined)).not.toThrow()
  })
})

describe('computeAfterText', () => {
  it('create / overwrite 的结果就是这次的内容', () => {
    expect(computeAfterText('create', MISSING, 'new')).toBe('new')
    expect(computeAfterText('overwrite', text('old'), 'new')).toBe('new')
  })

  it('append 要把旧内容接上——只存追加的那段会让回滚把文件截成别的东西', () => {
    expect(computeAfterText('append', text('one\n'), 'two\n')).toBe('one\ntwo\n')
  })

  it('append 到不存在的文件就是这次的内容', () => {
    expect(computeAfterText('append', MISSING, 'two\n')).toBe('two\n')
  })

  it('旧内容读不出来时整体退化成 null（接不出完整文本就没有可逆的资格）', () => {
    expect(computeAfterText('append', unsupported('binary files are not reversible'), 'x')).toBeNull()
  })

  it('新内容是二进制时也是 null', () => {
    expect(computeAfterText('append', text('one\n'), null)).toBeNull()
    expect(computeAfterText('overwrite', text('one\n'), null)).toBeNull()
  })
})

describe('reversibleReason', () => {
  it('旧内容读不出来的理由优先于「新内容是二进制」', () => {
    expect(reversibleReason(unsupported('non-UTF-8 files are not reversible'), null)).toBe(
      'non-UTF-8 files are not reversible',
    )
  })

  it('新内容是二进制', () => {
    expect(reversibleReason(MISSING, null)).toBe('binary content is not reversible')
  })

  it('写完之后超出可逆预算', () => {
    expect(reversibleReason(MISSING, 'x'.repeat(REVERSIBLE_MAX_BYTES + 1))).toBe(
      `resulting file exceeds the reversible ${REVERSIBLE_MAX_BYTES} byte limit`,
    )
  })

  it('可逆预算按字节算，不是按字符', () => {
    // 三分之一 MiB 的中文正好越过 1 MiB 字节预算；按 `.length` 算会判成「没超、可逆」，
    // 然后把它整份塞进变更日志。
    const chinese = '中'.repeat(Math.ceil(REVERSIBLE_MAX_BYTES / 3))
    expect(chinese.length).toBeLessThan(REVERSIBLE_MAX_BYTES)
    expect(reversibleReason(MISSING, chinese)).toContain('exceeds the reversible')
  })

  it('普通文本可逆', () => {
    expect(reversibleReason(text('old'), 'new')).toBeNull()
  })
})

describe('summarizeChange', () => {
  it('旧内容是文本 → 给出行级 diff', () => {
    expect(summarizeChange(text('a\n'), 'b\n', true)?.linesAdded).toBe(1)
  })

  it('文件原本不存在 → 全部算新增', () => {
    expect(summarizeChange(MISSING, 'a\nb\n', false)?.linesAdded).toBe(2)
  })

  it('文件存在但没读过旧内容（普通 append）→ 不给摘要，而不是硬说整份是新增的', () => {
    expect(summarizeChange(MISSING, 'a\n', true)).toBeNull()
  })

  it('写完之后不是文本 → 没有摘要', () => {
    expect(summarizeChange(text('a\n'), null, true)).toBeNull()
  })
})
