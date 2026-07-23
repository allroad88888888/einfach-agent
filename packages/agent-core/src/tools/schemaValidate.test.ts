import { describe, expect, it } from 'vitest'
import { validateAgainstSchema, type JsonSchema } from './schemaValidate'

describe('validateAgainstSchema · 无 schema', () => {
  it('schema 为 undefined/null 时原样放行，不做任何校验', () => {
    expect(validateAgainstSchema(undefined, { anything: 1 })).toEqual({
      ok: true,
      value: { anything: 1 },
    })
    expect(validateAgainstSchema(null, 'raw')).toEqual({ ok: true, value: 'raw' })
  })
})

describe('validateAgainstSchema · type', () => {
  const cases: Array<{ type: JsonSchema['type']; good: unknown; bad: unknown; badLabel: string }> = [
    { type: 'string', good: 'hi', bad: 1, badLabel: '数字 1' },
    { type: 'number', good: 1.5, bad: 'x', badLabel: "字符串 \"x\"" },
    { type: 'integer', good: 3, bad: 3.5, badLabel: '数字 3.5' },
    { type: 'boolean', good: true, bad: 'true', badLabel: "字符串 \"true\"" },
    { type: 'array', good: [1, 2], bad: {}, badLabel: '对象 {}' },
    { type: 'object', good: { a: 1 }, bad: [1], badLabel: '数组（长度 1）' },
    { type: 'null', good: null, bad: 0, badLabel: '数字 0' },
  ]

  for (const { type, good, bad, badLabel } of cases) {
    it(`${type}: 匹配类型通过`, () => {
      const result = validateAgainstSchema({ type }, good)
      expect(result.ok).toBe(true)
    })

    it(`${type}: 类型不符时报错并带上期望/实际`, () => {
      const result = validateAgainstSchema({ type }, bad)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errors[0]).toContain(`期望类型 ${type}`)
        expect(result.errors[0]).toContain(badLabel)
      }
    })
  }

  it('integer 类型拒绝非有限数（NaN/Infinity）', () => {
    const result = validateAgainstSchema({ type: 'integer' }, NaN)
    expect(result.ok).toBe(false)
  })

  it('缺省 type 但声明了 properties 时隐式按 object 校验', () => {
    const schema: JsonSchema = { properties: { a: { type: 'string' } } }
    const result = validateAgainstSchema(schema, 'not an object')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('期望类型 object')
  })
})

describe('validateAgainstSchema · required / properties', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer' },
    },
    required: ['query'],
  }

  it('必填字段存在时通过', () => {
    const result = validateAgainstSchema(schema, { query: 'q' })
    expect(result).toEqual({ ok: true, value: { query: 'q' } })
  })

  it('缺少必填字段时报错，带字段路径与期望类型', () => {
    const result = validateAgainstSchema(schema, {})
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('query')
      expect(result.errors[0]).toContain('缺少必填字段')
      expect(result.errors[0]).toContain('string 类型')
    }
  })

  it('可选字段缺失时不报错、也不出现在输出里', () => {
    const result = validateAgainstSchema(schema, { query: 'q' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.prototype.hasOwnProperty.call(result.value as object, 'limit')).toBe(false)
    }
  })

  it('required 里列出但 properties 未声明的字段：缺失仍报错', () => {
    const s: JsonSchema = { type: 'object', required: ['flag'] }
    const result = validateAgainstSchema(s, {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('flag')
  })

  it('收集全部错误，而不是遇到第一个就停', () => {
    const s: JsonSchema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a', 'b'],
    }
    const result = validateAgainstSchema(s, {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toHaveLength(2)
  })

  it('嵌套 object 属性的错误路径是 a.b 形式', () => {
    const s: JsonSchema = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: { b: { type: 'string' } },
          required: ['b'],
        },
      },
      required: ['a'],
    }
    const result = validateAgainstSchema(s, { a: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('a.b')
  })
})

describe('validateAgainstSchema · default 填充', () => {
  it('缺省字段用 default 填充进输出', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.' },
        recursive: { type: 'boolean', default: false },
      },
    }
    const result = validateAgainstSchema(schema, {})
    expect(result).toEqual({ ok: true, value: { path: '.', recursive: false } })
  })

  it('显式传入的值优先于 default', () => {
    const schema: JsonSchema = { type: 'object', properties: { path: { type: 'string', default: '.' } } }
    const result = validateAgainstSchema(schema, { path: '/tmp' })
    expect(result).toEqual({ ok: true, value: { path: '/tmp' } })
  })

  it('default 是对象/数组时每次返回独立拷贝，不共享引用', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { tags: { type: 'array', default: ['a'] } },
    }
    const first = validateAgainstSchema(schema, {})
    const second = validateAgainstSchema(schema, {})
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(first.value).toEqual(second.value)
      expect(first.value).not.toBe(second.value)
      ;(first.value as { tags: unknown[] }).tags.push('mutated')
      expect((second.value as { tags: unknown[] }).tags).toEqual(['a'])
    }
  })

  it('根 schema 自身带 default，且顶层 input 缺省时也能生效', () => {
    const schema: JsonSchema = { type: 'string', default: 'fallback' }
    const result = validateAgainstSchema(schema, undefined)
    expect(result).toEqual({ ok: true, value: 'fallback' })
  })
})

describe('validateAgainstSchema · enum / const', () => {
  it('enum 命中时通过', () => {
    const result = validateAgainstSchema({ enum: ['a', 'b'] }, 'a')
    expect(result).toEqual({ ok: true, value: 'a' })
  })

  it('enum 未命中时报错，列出全部候选与实际值', () => {
    const result = validateAgainstSchema({ enum: ['a', 'b'] }, 'c')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toContain("'a' | 'b'")
      expect(result.errors[0]).toContain("字符串 \"c\"")
    }
  })

  it('enum 无需伴随 type 关键字也能独立生效（如 browser-action 的 action 字段）', () => {
    const schema: JsonSchema = { enum: ['render_card'] }
    expect(validateAgainstSchema(schema, 'render_card').ok).toBe(true)
    expect(validateAgainstSchema(schema, 'unknown_action').ok).toBe(false)
  })

  it('const 命中时通过', () => {
    const result = validateAgainstSchema({ const: 'add_file' }, 'add_file')
    expect(result.ok).toBe(true)
  })

  it('const 不匹配时报错', () => {
    const result = validateAgainstSchema({ const: 'add_file' }, 'delete_file')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toContain("'add_file'")
      expect(result.errors[0]).toContain('"delete_file"')
    }
  })
})

describe('validateAgainstSchema · minimum/maximum（钳位语义，不是拒绝语义）', () => {
  const numSchema: JsonSchema = { type: 'integer', minimum: 1, maximum: 10 }

  it('边界值（含端点）通过，且不产生 warning', () => {
    const low = validateAgainstSchema(numSchema, 1)
    const high = validateAgainstSchema(numSchema, 10)
    expect(low).toEqual({ ok: true, value: 1 })
    expect(high).toEqual({ ok: true, value: 10 })
  })

  // 下界【不钳位、直接报错】——与上界故意不对称，别顺手统一（理由见 schemaValidate.ts 该分支注释）：
  // 各工具对「低于下限」的既有处理是 fallback 到默认值而非 clamp（write-file 的 normalizeMaxBytes
  // 写的是 `if (value <= 0) return DEFAULT_MAX_BYTES`）。若在 schema 层把 0 钳成 minimum，
  // 工具的 fallback 分支就永远进不去：maxBytes:0 会从「用 200KB 默认值」变成「1 字节上限」。
  it('小于 minimum：报错而不是钳位（否则会吃掉各工具的 fallback 语义）', () => {
    const result = validateAgainstSchema(numSchema, 0)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('应 ≥ 1')
    }
  })

  it('大于 maximum：钳位为 maximum，ok 仍为 true，并记一条 warning（字段路径示例：contextLines）', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { contextLines: { type: 'integer', minimum: 0, maximum: 5 } },
    }
    const result = validateAgainstSchema(schema, { contextLines: 10 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({ contextLines: 5 })
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings?.[0]).toContain('contextLines')
      expect(result.warnings?.[0]).toContain('超出上限 5')
      expect(result.warnings?.[0]).toContain('已钳位为 5')
    }
  })

  it('未越界时不带 warnings 字段（保持成功分支形状精简，不无谓塞空数组）', () => {
    const result = validateAgainstSchema(numSchema, 5)
    expect(result).toEqual({ ok: true, value: 5 })
    if (result.ok) {
      expect(result.warnings).toBeUndefined()
    }
  })

  it('同一字段 minimum/maximum 越界回归：rg-search 式的 timeoutMs 超上限仍能钳位执行（不再报错拒绝）', () => {
    // 对应真实回归场景：模型给长构建传 timeoutMs:300000，schema maximum:120000。
    const schema: JsonSchema = { type: 'integer', minimum: 1000, maximum: 120000 }
    const result = validateAgainstSchema(schema, 300000)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe(120000)
      expect(result.warnings?.[0]).toContain('超出上限 120000')
    }
  })
})

describe('validateAgainstSchema · minLength/maxLength/minItems/maxItems（维持拒绝语义，不可与数值钳位混同）', () => {
  const strSchema: JsonSchema = { type: 'string', minLength: 2, maxLength: 4 }

  it('字符串长度边界（含端点）通过', () => {
    expect(validateAgainstSchema(strSchema, 'ab').ok).toBe(true)
    expect(validateAgainstSchema(strSchema, 'abcd').ok).toBe(true)
  })

  it('字符串过短仍然报错（不能静默截断/填充，会丢失或捏造数据）', () => {
    const result = validateAgainstSchema(strSchema, 'a')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('长度应 ≥ 2')
  })

  it('字符串过长仍然报错（不能静默截断字符串，会丢失模型/用户给出的数据）', () => {
    const result = validateAgainstSchema(strSchema, 'abcde')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('长度应 ≤ 4')
  })

  const arrSchema: JsonSchema = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 }

  it('数组过短仍然报错（不能静默补项）', () => {
    const result = validateAgainstSchema(arrSchema, [])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('数组长度应 ≥ 1')
  })

  it('数组过长仍然报错（不能静默截断数组，会丢失模型/用户给出的元素）', () => {
    const result = validateAgainstSchema(arrSchema, ['a', 'b', 'c'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('数组长度应 ≤ 2')
  })
})

describe('validateAgainstSchema · items / minItems / maxItems', () => {
  const schema: JsonSchema = {
    type: 'array',
    items: { type: 'string' },
    minItems: 1,
    maxItems: 2,
  }

  it('每项都合法时通过', () => {
    const result = validateAgainstSchema(schema, ['a', 'b'])
    expect(result).toEqual({ ok: true, value: ['a', 'b'] })
  })

  it('数组过短/过长报错', () => {
    expect(validateAgainstSchema(schema, []).ok).toBe(false)
    expect(validateAgainstSchema(schema, ['a', 'b', 'c']).ok).toBe(false)
  })

  it('元素类型错误时报错，路径带下标（如 arr[1]）', () => {
    const wrapped: JsonSchema = { type: 'object', properties: { arr: schema } }
    const result = validateAgainstSchema(wrapped, { arr: ['a', 2] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('arr[1]')
  })

  it('未声明 items 时数组元素不做结构校验，原样返回', () => {
    const result = validateAgainstSchema({ type: 'array' }, [1, 'two', { three: 3 }])
    expect(result).toEqual({ ok: true, value: [1, 'two', { three: 3 }] })
  })
})

describe('validateAgainstSchema · additionalProperties', () => {
  it('additionalProperties: false 时，未声明字段报错', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { kind: { type: 'string' } },
      required: ['kind'],
      additionalProperties: false,
    }
    const result = validateAgainstSchema(schema, { kind: 'test', extra: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toContain('extra')
      expect(result.errors[0]).toContain('额外字段')
    }
  })

  it('additionalProperties 未声明或为 true 时，额外字段被透传保留', () => {
    const schema: JsonSchema = { type: 'object', properties: { kind: { type: 'string' } } }
    const result = validateAgainstSchema(schema, { kind: 'test', extra: 1 })
    expect(result).toEqual({ ok: true, value: { kind: 'test', extra: 1 } })
  })

  it('additionalProperties 为 schema 时（如 shell env），逐个校验额外字段的值', () => {
    const schema: JsonSchema = {
      type: 'object',
      additionalProperties: { type: 'string' },
    }
    const ok = validateAgainstSchema(schema, { FOO: 'bar', BAZ: 'qux' })
    expect(ok).toEqual({ ok: true, value: { FOO: 'bar', BAZ: 'qux' } })

    const bad = validateAgainstSchema(schema, { FOO: 123 })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.errors[0]).toContain('FOO')
      expect(bad.errors[0]).toContain('期望类型 string')
    }
  })
})

describe('validateAgainstSchema · 未知关键字忽略', () => {
  it('description 等未识别关键字不影响校验结果', () => {
    const schema: JsonSchema = {
      type: 'string',
      description: '这是一个说明，不是校验规则',
      someMadeUpKeyword: { whatever: true },
    }
    const result = validateAgainstSchema(schema, 'ok')
    expect(result).toEqual({ ok: true, value: 'ok' })
  })
})

describe('validateAgainstSchema · oneOf（简单场景）', () => {
  const schema: JsonSchema = {
    oneOf: [
      { type: 'string' },
      { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
    ],
  }

  it('命中任一分支即通过', () => {
    expect(validateAgainstSchema(schema, 'hi')).toEqual({ ok: true, value: 'hi' })
    expect(validateAgainstSchema(schema, { n: 1 })).toEqual({ ok: true, value: { n: 1 } })
  })

  it('无判别字段时，全部分支都不匹配则报通用错误', () => {
    const result = validateAgainstSchema(schema, 42)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('不满足 oneOf 中任何一种候选结构')
  })
})
