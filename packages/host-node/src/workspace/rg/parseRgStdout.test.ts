import { describe, expect, it } from 'vitest'
import { parseRgStdout } from './parseRgStdout'

/** 把固定的 rg `--json` 行数组包成 AsyncIterable<string>——不起真实 rg 进程也能测解析逻辑。 */
async function* linesOf(...lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line
}

function matchLine(path: string, lineNumber: number, text: string, start = 0): string {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: path },
      lines: { text: `${text}\n` },
      line_number: lineNumber,
      submatches: [{ match: { text: 'x' }, start, end: start + 1 }],
    },
  })
}

function contextLine(path: string, lineNumber: number, text: string): string {
  return JSON.stringify({
    type: 'context',
    data: { path: { text: path }, lines: { text: `${text}\n` }, line_number: lineNumber },
  })
}

const beginLine = (path: string) => JSON.stringify({ type: 'begin', data: { path: { text: path } } })
const endLine = (path: string) => JSON.stringify({ type: 'end', data: { path: { text: path } } })
const summaryLine = () => JSON.stringify({ type: 'summary', data: { elapsed_total: {} } })

describe('parseRgStdout', () => {
  it('解析一条命中：路径、行号、列号（1-based）、行文本（去掉尾部换行）', async () => {
    const result = await parseRgStdout(
      linesOf(beginLine('a.ts'), matchLine('a.ts', 10, 'const x = 1', 6), endLine('a.ts'), summaryLine()),
      '/root',
      0,
      200,
      () => {},
    )
    expect(result.truncated).toBe(false)
    expect(result.matches).toEqual([
      { path: 'a.ts', lineNumber: 10, column: 7, line: 'const x = 1', before: [], after: [] },
    ])
  })

  it('忽略 begin/end/summary 与解析不出 JSON 的行', async () => {
    const result = await parseRgStdout(
      linesOf(beginLine('a.ts'), 'not json at all', matchLine('a.ts', 1, 'hit'), endLine('a.ts')),
      '/root',
      0,
      200,
      () => {},
    )
    expect(result.matches).toHaveLength(1)
  })

  it('submatches 缺失时列号退回 1，line_number 缺失时行号退回 0', async () => {
    const bareMatch = JSON.stringify({
      type: 'match',
      data: { path: { text: 'a.ts' }, lines: { text: 'x\n' } },
    })
    const result = await parseRgStdout(linesOf(bareMatch), '/root', 0, 200, () => {})
    expect(result.matches).toEqual([{ path: 'a.ts', lineNumber: 0, column: 1, line: 'x', before: [], after: [] }])
  })

  it('上下文行：命中之前的进 before（钳容量），命中之后的进 after', async () => {
    const result = await parseRgStdout(
      linesOf(
        contextLine('a.ts', 7, 'l7'),
        contextLine('a.ts', 8, 'l8'),
        contextLine('a.ts', 9, 'l9'), // 3 条，contextLines=2 → 应丢最旧的 l7
        matchLine('a.ts', 10, 'hit'),
        contextLine('a.ts', 11, 'l11'),
        contextLine('a.ts', 12, 'l12'),
      ),
      '/root',
      2,
      200,
      () => {},
    )
    expect(result.matches).toEqual([
      { path: 'a.ts', lineNumber: 10, column: 1, line: 'hit', before: ['l8', 'l9'], after: ['l11', 'l12'] },
    ])
  })

  it('contextLines=0 时不缓冲 before，也不追加 after', async () => {
    const result = await parseRgStdout(
      linesOf(contextLine('a.ts', 9, 'l9'), matchLine('a.ts', 10, 'hit'), contextLine('a.ts', 11, 'l11')),
      '/root',
      0,
      200,
      () => {},
    )
    expect(result.matches).toEqual([
      { path: 'a.ts', lineNumber: 10, column: 1, line: 'hit', before: [], after: [] },
    ])
  })

  it('两个连续命中之间：before 清空重新累积，after 计数按新命中重置', async () => {
    const result = await parseRgStdout(
      linesOf(
        matchLine('a.ts', 1, 'first'),
        contextLine('a.ts', 2, 'between'),
        matchLine('a.ts', 3, 'second'),
      ),
      '/root',
      1,
      200,
      () => {},
    )
    expect(result.matches).toEqual([
      { path: 'a.ts', lineNumber: 1, column: 1, line: 'first', before: [], after: ['between'] },
      { path: 'a.ts', lineNumber: 3, column: 1, line: 'second', before: [], after: [] },
    ])
  })

  it('到 maxMatches 立刻停：不读后续行，标记 truncated，回调一次', async () => {
    let killed = 0
    const result = await parseRgStdout(
      linesOf(matchLine('a.ts', 1, 'one'), matchLine('a.ts', 2, 'two'), matchLine('a.ts', 3, 'three')),
      '/root',
      0,
      1,
      () => {
        killed += 1
      },
    )
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.line).toBe('one')
    expect(result.truncated).toBe(true)
    expect(killed).toBe(1)
  })

  it('展示路径：root 内绝对路径转根相对斜杠路径，root 外绝对路径原样（仅斜杠化）', async () => {
    const inside = await parseRgStdout(linesOf(matchLine('/root/src/a.ts', 1, 'x')), '/root', 0, 200, () => {})
    expect(inside.matches[0]?.path).toBe('src/a.ts')

    const outside = await parseRgStdout(linesOf(matchLine('/other/a.ts', 1, 'x')), '/root', 0, 200, () => {})
    expect(outside.matches[0]?.path).toBe('/other/a.ts')
  })

  it('展示路径：相对路径原样透传（rg 以 cwd=root 运行时的常见形状）', async () => {
    const result = await parseRgStdout(linesOf(matchLine('src/a.ts', 1, 'x')), '/root', 0, 200, () => {})
    expect(result.matches[0]?.path).toBe('src/a.ts')
  })
})
