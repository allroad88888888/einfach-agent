import { deepStrictEqual } from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { assertJsonEventPayload } from './jsonPayload'

// 本文件钉的不是「验器有没有 bug」，而是**验器的规则集是否真的等于 JSON 的保真行为**。
// 那句话是整个事件面的立身之本：CLI 那条路不序列化，却要与 SSE 那条路看到同一个值；
// 唯一能兑现它的方式就是让进程内也执行 JSON 的约束。规则集若比 JSON 松，就有「本地能跑、
// 过了 SSE 变形」的缝；若比 JSON 紧，就是无谓地拒掉合法载荷。
//
// 判据用 `node:assert` 的 `deepStrictEqual` 而不是 vitest 的 `toEqual`：后者认为
// `{ a: undefined }` 与 `{}` 相等，而那**正是**要抓的一种分岔。`deepStrictEqual` 比对自有可枚举
// 键（含 Symbol 键）、用 `Object.is` 比标量（因此 `-0 !== +0`）、并且比原型——三条恰好对上
// 「进程内 handler 与 SSE handler 是否看到同一个东西」。
function survivesJsonRoundTrip(value: unknown): boolean {
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    return false // BigInt、循环引用：连序列化都过不去。
  }
  try {
    deepStrictEqual(JSON.parse(serialized), value)
    return true
  } catch {
    return false
  }
}

// 一份合法的 record 外壳，把被测值放进 `probe` 字段——顶层「必须是 record」是另一条独立规则，
// 与 JSON 保真无关，单独在下面那个 describe 里测。
function wrap(probe: unknown): unknown {
  return { serverId: 's', sessionToken: 't', probe }
}

function sparseArray(): unknown {
  const array: unknown[] = []
  array[1] = 1 // length 2、只有下标 1 存在：空洞过 JSON 会变成 null。
  return array
}

const ACCEPTED: ReadonlyArray<readonly [string, unknown]> = [
  ['字符串', 'hello'],
  ['空字符串', ''],
  ['含孤立代理项的字符串', '\uD800'],
  ['整数', 42],
  ['负数', -1],
  ['小数', 1.5],
  ['正零', 0],
  ['极大有限数', Number.MAX_VALUE],
  ['布尔', true],
  ['null', null],
  ['空对象', {}],
  ['嵌套对象', { a: { b: { c: 'd' } } }],
  ['空数组', []],
  ['标量数组', [1, 'two', false, null]],
  ['对象数组', [{ a: 1 }, { a: 2 }]],
  // 菱形引用：同一个子对象出现两次但不成环。JSON 展开成两份内容相同的副本，结构仍然相等。
  ['菱形引用', (() => {
    const shared = { shared: true }
    return { left: shared, right: shared }
  })()],
]

const REJECTED: ReadonlyArray<readonly [string, unknown, string]> = [
  ['undefined 值', undefined, 'drops the key entirely'],
  ['函数值', () => {}, 'is a function'],
  ['Symbol 值', Symbol('x'), 'is a symbol'],
  ['bigint 值', 10n, 'is a bigint'],
  ['NaN', Number.NaN, 'rewrites it as null'],
  ['Infinity', Number.POSITIVE_INFINITY, 'rewrites it as null'],
  ['负零', -0, 'is -0'],
  ['Date', new Date(0), 'is a Date'],
  ['Map', new Map([['a', 1]]), 'is a Map'],
  ['Set', new Set([1]), 'is a Set'],
  ['Error', new Error('boom'), 'is an Error'],
  ['class 实例', new (class Thing { value = 1 })(), 'is a Thing'],
  ['null 原型对象', Object.create(null), 'is a null-prototype object'],
  ['Symbol 键的属性', { [Symbol('k')]: 1 }, 'symbol-keyed properties'],
  ['稀疏数组', sparseArray(), 'sparse array or carries extra own properties'],
  ['挂了额外属性的数组', Object.assign([1], { extra: 'x' }), 'sparse array or carries extra own properties'],
  ['深处的 undefined', { deep: { deeper: [{ bad: undefined }] } }, 'drops the key entirely'],
]

describe('JSON 载荷判据 == JSON 的保真行为', () => {
  for (const [label, probe] of ACCEPTED) {
    it(`放行「${label}」，且它确实能原样过一次 JSON 往返`, () => {
      const payload = wrap(probe)
      expect(() => assertJsonEventPayload('mcp-stdio-close', payload)).not.toThrow()
      expect(survivesJsonRoundTrip(payload)).toBe(true)
    })
  }

  for (const [label, probe, fragment] of REJECTED) {
    it(`拒绝「${label}」，且它确实过不了 JSON 往返`, () => {
      const payload = wrap(probe)
      expect(() => assertJsonEventPayload('mcp-stdio-close', payload)).toThrow(TypeError)
      expect(() => assertJsonEventPayload('mcp-stdio-close', payload)).toThrow(fragment)
      expect(survivesJsonRoundTrip(payload)).toBe(false)
    })
  }

  it('循环引用：拒绝，且 JSON.stringify 本来就抛', () => {
    const cyclic: Record<string, unknown> = { serverId: 's' }
    cyclic.self = cyclic
    expect(() => assertJsonEventPayload('mcp-stdio-close', cyclic)).toThrow('circular reference')
    expect(() => JSON.stringify(cyclic)).toThrow()
    expect(survivesJsonRoundTrip(cyclic)).toBe(false)
  })

  it('报错指得出出问题的路径，而不只是说「载荷不合法」', () => {
    expect(() => assertJsonEventPayload('mcp-stdio-close', { a: { b: [{ c: new Date(0) }] } }))
      .toThrow('payload.a.b[0].c')
  })

  it('报错带上事件名，便于在多路事件里定位发射点', () => {
    expect(() => assertJsonEventPayload('mcp-stdio-tools-changed', { bad: undefined }))
      .toThrow('mcp-stdio-tools-changed')
  })
})

describe('顶层必须是普通对象', () => {
  // 这一条**不是** JSON 保真规则——数组和标量都能好好地过 JSON 往返。它是本事件面自己的收窄：
  // 一帧 SSE 的 `data:` 携带一份 JSON 文档，record 形态才留得下「以后往载荷里加字段」的余地。
  const NON_RECORDS: ReadonlyArray<readonly [string, unknown]> = [
    ['数组', [1, 2]],
    ['字符串', 'plain'],
    ['数字', 1],
    ['null', null],
    ['undefined', undefined],
    ['Date', new Date(0)],
  ]

  for (const [label, payload] of NON_RECORDS) {
    it(`拒绝顶层是「${label}」的载荷`, () => {
      expect(() => assertJsonEventPayload('mcp-stdio-close', payload))
        .toThrow('payload must be a plain object')
    })
  }

  it('被拒的顶层数组其实能过 JSON 往返——所以这条是额外收窄，不是保真判据', () => {
    expect(survivesJsonRoundTrip([1, 2])).toBe(true)
  })
})
