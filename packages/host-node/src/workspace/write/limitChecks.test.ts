import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_LOCK_POLL_MS,
  ARCHIVE_LOCK_STALE_MS,
  ARCHIVE_LOCK_WAIT_MS,
  INDEX_COMPACT_MAX_BYTES,
  INDEX_COMPACT_MIN_BYTES,
  INDEX_COMPACT_THROTTLE_MS,
  MAX_BYTES,
  PATH_LOCK_SWEEP_THRESHOLD,
  REVERSIBLE_MAX_BYTES,
} from './limits'
import {
  afterExceedsReversibleBudget,
  beforeExceedsReversibleBudget,
  contentTooLargeMessage,
  normalizeMaxBytes,
} from './limitChecks'

describe('限额常量', () => {
  it('与 workspace_write_limits.rs 逐条相等', () => {
    // 展开成字面量而不是重复那几个乘法：这条测试的作用是「改了值会响」，
    // 用同一个表达式两边一起改就什么也测不到了。
    expect(MAX_BYTES).toBe(8_388_608)
    expect(REVERSIBLE_MAX_BYTES).toBe(1_048_576)
    expect(PATH_LOCK_SWEEP_THRESHOLD).toBe(1024)
    expect(ARCHIVE_LOCK_WAIT_MS).toBe(10_000)
    expect(ARCHIVE_LOCK_STALE_MS).toBe(30_000)
    expect(ARCHIVE_LOCK_POLL_MS).toBe(20)
    expect(INDEX_COMPACT_MIN_BYTES).toBe(131_072)
    expect(INDEX_COMPACT_THROTTLE_MS).toBe(300_000)
    expect(INDEX_COMPACT_MAX_BYTES).toBe(16_777_216)
  })
})

describe('normalizeMaxBytes', () => {
  it('未传 = 取硬上限，不是取一个更小的默认值', () => {
    expect(normalizeMaxBytes(undefined)).toBe(MAX_BYTES)
    expect(normalizeMaxBytes(null)).toBe(MAX_BYTES)
  })

  it('正数按原值，但恒被硬上限钳住', () => {
    expect(normalizeMaxBytes(1024)).toBe(1024)
    expect(normalizeMaxBytes(MAX_BYTES)).toBe(MAX_BYTES)
    expect(normalizeMaxBytes(MAX_BYTES + 1)).toBe(MAX_BYTES)
    expect(normalizeMaxBytes(Number.MAX_SAFE_INTEGER)).toBe(MAX_BYTES)
  })

  it('0 与负数不是「不限」，按未传处理', () => {
    expect(normalizeMaxBytes(0)).toBe(MAX_BYTES)
    expect(normalizeMaxBytes(-1)).toBe(MAX_BYTES)
  })

  it('小数、NaN、Infinity、字符串都按未传处理（Rust 侧由 serde 挡掉，这里没有那道关卡）', () => {
    expect(normalizeMaxBytes(1.5)).toBe(MAX_BYTES)
    expect(normalizeMaxBytes(Number.NaN)).toBe(MAX_BYTES)
    expect(normalizeMaxBytes(Number.POSITIVE_INFINITY)).toBe(MAX_BYTES)
    expect(normalizeMaxBytes('1024')).toBe(MAX_BYTES)
  })
})

describe('contentTooLargeMessage', () => {
  it('恰好等于上限不算超（边界是 `>`）', () => {
    expect(contentTooLargeMessage(1024, 1024)).toBeUndefined()
  })

  it('超限时文案与 Rust 逐字一致', () => {
    expect(contentTooLargeMessage(1025, 1024)).toBe(
      'content is too large: 1025 bytes exceeds limit 1024',
    )
  })

  it('上限是调用方自设值时也用那个值报数', () => {
    // maxBytes 已被 normalizeMaxBytes 钳过，所以这里报的恒是「本次真正生效的上限」。
    expect(contentTooLargeMessage(MAX_BYTES, 4096)).toBe(
      `content is too large: ${MAX_BYTES} bytes exceeds limit 4096`,
    )
  })
})

describe('可逆预算', () => {
  it('旧文件按 MAX_BYTES 判，文案照搬 Rust（含那句与常量对不上的 "reversible"）', () => {
    expect(beforeExceedsReversibleBudget(MAX_BYTES)).toBeUndefined()
    expect(beforeExceedsReversibleBudget(MAX_BYTES + 1)).toBe(
      'existing file exceeds reversible 8388608 byte limit',
    )
  })

  it('写后内容按 REVERSIBLE_MAX_BYTES 判', () => {
    expect(afterExceedsReversibleBudget('x'.repeat(REVERSIBLE_MAX_BYTES))).toBeUndefined()
    expect(afterExceedsReversibleBudget('x'.repeat(REVERSIBLE_MAX_BYTES + 1))).toBe(
      'resulting file exceeds the reversible 1048576 byte limit',
    )
  })

  it('按字节数判，不是按 string.length', () => {
    // 一个中文字符 3 字节：40 万字的 length 远没到 1 MiB，字节数却有 1.2 MB。
    // 直译成 `.length` 会把这份内容判成可逆，然后整份塞进变更日志。
    const chinese = '中'.repeat(400_000)
    expect(chinese.length).toBeLessThan(REVERSIBLE_MAX_BYTES)
    expect(afterExceedsReversibleBudget(chinese)).toBe(
      'resulting file exceeds the reversible 1048576 byte limit',
    )
  })
})
