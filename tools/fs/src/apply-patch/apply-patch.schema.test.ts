// apply-patch 的真实复杂 schema × core 校验器（validateAgainstSchema）——TSPLIT TS2 从 agent-core 迁入。
// ---------------------------------------------------------------------------
// apply-patch 的 inputSchema 是全工具里最复杂的（嵌套 oneOf + const 判别联合）。用它压测 core 的
// validateAgainstSchema 最有代表性，故这组用例住在 apply-patch 这里（tools-fs），从 @einfach-agent/core
// 取校验器 —— 依赖方向 tools-fs → core，自然单向；agent-core 的 schemaValidate.test 从此不再引具体工具。
import { describe, expect, it } from 'vitest'
import { validateAgainstSchema, type JsonSchema } from '@einfach-agent/core/tools/schemaValidate'
import { applyPatchTool } from './apply-patch'

describe('validateAgainstSchema · apply-patch 真实的嵌套 oneOf + const 判别联合', () => {
  const schema = applyPatchTool.inputSchema as JsonSchema

  it('add_file 分支：合法输入通过，且 dryRun 缺省时不被强行填充（无 default）', () => {
    const result = validateAgainstSchema(schema, {
      operations: [{ type: 'add_file', path: 'a.txt', content: 'hello' }],
    })
    expect(result).toEqual({
      ok: true,
      value: { operations: [{ type: 'add_file', path: 'a.txt', content: 'hello' }] },
    })
  })

  it('delete_file 分支：oldContent 可选，缺省时通过', () => {
    const result = validateAgainstSchema(schema, {
      operations: [{ type: 'delete_file', path: 'a.txt' }],
    })
    expect(result.ok).toBe(true)
  })

  // expectedReplacements:0 是模型表达「预期 0 处替换」，绝不能被钳成 1 —— 那是语义反转，
  // 会让一次「这段不该存在」的断言变成「替换掉 1 处」而真的改文件。apply-patch 的 execute
  // 原本就把它拒为 'must be a positive integer'，schema 层必须保持同样的拒绝语义。
  it('replace 分支：expectedReplacements:0 必须拒绝（钳成 1 会让参数语义反转）', () => {
    const rejected = validateAgainstSchema(schema, {
      operations: [
        { type: 'replace', path: 'a.txt', oldText: 'x', newText: 'y', expectedReplacements: 0 },
      ],
    })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.errors.join('；')).toContain('operations[0].expectedReplacements')
    }

    const good = validateAgainstSchema(schema, {
      operations: [
        { type: 'replace', path: 'a.txt', oldText: 'x', newText: 'y', expectedReplacements: 2 },
      ],
    })
    expect(good.ok).toBe(true)
  })

  it('overwrite_file 分支：content 必填，oldContent 可选', () => {
    const result = validateAgainstSchema(schema, {
      operations: [{ type: 'overwrite_file', path: 'a.txt', content: 'new' }],
    })
    expect(result.ok).toBe(true)
  })

  it('分支内字段缺失：报出该分支自身的具体错误（而不是四份 oneOf 错误堆一起），且带下标路径', () => {
    const result = validateAgainstSchema(schema, {
      operations: [{ type: 'add_file', path: 'a.txt' }], // 缺 content
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('operations[0].content')
    }
  })

  it('分支内字段类型错误：定位到具体字段路径', () => {
    const result = validateAgainstSchema(schema, {
      operations: [{ type: 'add_file', path: 'a.txt', content: 123 }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('operations[0].content')
  })

  it('type 取值不在四选一范围内：报出判别字段本身的期望/实际', () => {
    const result = validateAgainstSchema(schema, {
      operations: [{ type: 'rename_file', path: 'a.txt' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0]).toContain('operations[0].type')
      expect(result.errors[0]).toContain("'add_file'")
      expect(result.errors[0]).toContain('"rename_file"')
    }
  })

  it('完全缺少 type 字段：同样定位到判别字段', () => {
    const result = validateAgainstSchema(schema, {
      operations: [{ path: 'a.txt', content: 'x' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('operations[0].type')
  })

  it('operations 顶层缺失：报出顶层必填错误', () => {
    const result = validateAgainstSchema(schema, {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('operations')
  })

  it('多条 operations 时每条独立校验，互不影响，错误各自带正确下标', () => {
    const result = validateAgainstSchema(schema, {
      operations: [
        { type: 'add_file', path: 'a.txt', content: 'ok' },
        { type: 'add_file', path: 'b.txt' }, // 缺 content
      ],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('operations[1].content')
    }
  })

  it('dryRun 为顶层可选布尔字段，传入时保留', () => {
    const result = validateAgainstSchema(schema, {
      operations: [{ type: 'delete_file', path: 'a.txt' }],
      dryRun: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.value as { dryRun: boolean }).dryRun).toBe(true)
    }
  })
})
