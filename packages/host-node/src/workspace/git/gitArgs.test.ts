import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_DIFF_CHARS,
  MAX_DIFF_CHARS,
  diffArgs,
  diffNameOnlyArgs,
  normalizeBase,
  normalizeMaxDiffChars,
  statusArgs,
} from './gitArgs'

/** 控制字符用 fromCharCode 造，不往源码里嵌真的 NUL / DEL 字节。 */
const NUL = String.fromCharCode(0)
const DEL = String.fromCharCode(127)

describe('diff argv 的 P1 三件套', () => {
  // 对齐 Rust 的 diff_args_disable_external_diff_and_textconv：四种组合都要带全，
  // 而且 `-c diff.external=` 必须作为**全局**选项排在子命令 `diff` 之前（排在后面 git 不认）。
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('staged=%s stat=%s 时外部 diff / textconv 全被堵死', (staged, stat) => {
    const args = diffArgs(staged, undefined, stat, [])

    const externalIndex = args.indexOf('diff.external=')
    const diffIndex = args.indexOf('diff')
    expect(externalIndex).toBeGreaterThanOrEqual(0)
    expect(diffIndex).toBeGreaterThanOrEqual(0)
    expect(externalIndex).toBeLessThan(diffIndex)
    expect(args[externalIndex - 1]).toBe('-c')
    expect(args).toContain('--no-ext-diff')
    expect(args).toContain('--no-textconv')
  })

  it('--name-only 形态同样带全三件套（三种形态共用一个构造点，漏掉是静默的）', () => {
    const args = diffNameOnlyArgs(false, undefined, [])
    expect(args.slice(0, 5)).toEqual([
      '-c',
      'diff.external=',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
    ])
    expect(args).toContain('--name-only')
  })

  // 对齐 Rust 的 status_args_have_no_diff_only_flags：这两个 flag 是 diff 专属，
  // status 带上会直接报错；status 的外部命令兜底靠 env，参数层保持干净。
  it('status 不带 diff 专属选项', () => {
    const args = statusArgs([])
    expect(args).toEqual(['status', '--short'])
    expect(args).not.toContain('--no-ext-diff')
    expect(args).not.toContain('--no-textconv')
    expect(args).not.toContain('diff.external=')
  })
})

describe('pathspec 的位置', () => {
  it('diff 的 pathspec 一律排在 `--` 之后', () => {
    const args = diffArgs(false, 'HEAD~1', false, ['a.txt', '-weird-name'])
    const separator = args.indexOf('--')
    expect(separator).toBeGreaterThanOrEqual(0)
    // `--` 之后 git 不再解析选项，所以哪怕文件名以 `-` 开头也变不成 flag。
    expect(args.slice(separator + 1)).toEqual(['a.txt', '-weird-name'])
    expect(args.indexOf('HEAD~1')).toBeLessThan(separator)
  })

  it('没有 pathspec 时不加 `--`（全仓形态）', () => {
    expect(diffArgs(false, undefined, false, [])).not.toContain('--')
    expect(statusArgs([])).not.toContain('--')
  })

  it('status 的 pathspec 同样排在 `--` 之后', () => {
    expect(statusArgs(['a.txt'])).toEqual(['status', '--short', '--', 'a.txt'])
  })
})

describe('normalizeBase', () => {
  it('不传就是不比对 base', () => {
    expect(normalizeBase(undefined)).toBeUndefined()
  })

  it('首尾空白只是被修剪，不构成拒绝', () => {
    expect(normalizeBase('  HEAD~1\n')).toBe('HEAD~1')
  })

  it('空 / 全空白直接拒', () => {
    expect(() => normalizeBase('')).toThrow('git diff base cannot be empty')
    expect(() => normalizeBase('   ')).toThrow('git diff base cannot be empty')
  })

  // 这条是白名单里真正挡注入的那一条：base 出现在 `--` 之前，git 仍在解析选项。
  // `--output=` 能让「只读」的 diff 往任意路径写文件，`--ext-diff` 能把 P1 的命令行那一层掀掉。
  it.each(['--output=/tmp/x', '--ext-diff', '-c', '--upload-pack=touch /tmp/pwn', '--'])(
    '以 `-` 开头的 base 一律拒：%s',
    (base) => {
      expect(() => normalizeBase(base)).toThrow(/without leading/)
    },
  )

  // 没有 shell，所以这条不是拆词防线；它挡的是「合法 ref 本来就不许有这些字符」，以及
  // 「含换行的值会在 stderr / 日志里伪造出额外一行」。首尾空白先被修剪，只有夹在中间的才拒。
  it.each(['HEAD 1', 'HEAD\n--output=/tmp/x', 'HEAD\tx', `HEAD${NUL}x`, `HEAD${DEL}x`])(
    '含空白或控制字符的 base 一律拒：%s',
    (base) => {
      expect(() => normalizeBase(base)).toThrow(/whitespace, or control characters/)
    },
  )

  it('合法 ref 原样放行', () => {
    expect(normalizeBase('origin/main')).toBe('origin/main')
    expect(normalizeBase('HEAD~3')).toBe('HEAD~3')
  })
})

describe('normalizeMaxDiffChars', () => {
  it('未指定 / 0 取默认值', () => {
    expect(normalizeMaxDiffChars(undefined)).toBe(DEFAULT_MAX_DIFF_CHARS)
    expect(normalizeMaxDiffChars(0)).toBe(DEFAULT_MAX_DIFF_CHARS)
  })

  it('调用方只能往下要，不能往上加', () => {
    expect(normalizeMaxDiffChars(10)).toBe(10)
    expect(normalizeMaxDiffChars(MAX_DIFF_CHARS * 10)).toBe(MAX_DIFF_CHARS)
  })
})
