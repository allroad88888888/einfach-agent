import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from './manifest'
import type { ManifestDiagnostic, ManifestDiagnosticCode } from './manifestTypes'

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acme.hello',
    name: 'Hello 插件',
    version: '1.4.2',
    apiVersion: '1.0.0',
    capabilities: ['hooks'],
    entry: { core: 'core.js' },
    ...overrides,
  }
}

function diagnosticsOf(raw: unknown): readonly ManifestDiagnostic[] {
  const result = parsePluginManifest(raw)
  if (result.ok) throw new Error('预期解析失败，实际成功')
  return result.diagnostics
}

function codesOf(raw: unknown): ManifestDiagnosticCode[] {
  return diagnosticsOf(raw).map((diagnostic) => diagnostic.code)
}

function expectSingle(raw: unknown, code: ManifestDiagnosticCode, field?: string): void {
  const diagnostics = diagnosticsOf(raw)
  expect(diagnostics).toHaveLength(1)
  expect(diagnostics[0]?.code).toBe(code)
  if (field !== undefined) expect(diagnostics[0]?.field).toBe(field)
  // 面向用户的诊断文案保持中文且非空。
  expect(diagnostics[0]?.message.trim().length ?? 0).toBeGreaterThan(0)
}

describe('顶层形状', () => {
  // 每个用例都包一层数组：it.each 会把数组元素展开成参数，直接写数组会被拆散。
  it.each([[null], [undefined], ['plugin'], [42], [true], [[]], [[{ id: 'acme.hello' }]]])(
    '非对象输入 %s 归为 not_an_object',
    (raw: unknown) => {
      expectSingle(raw, 'not_an_object')
    },
  )

  it('任何坏输入都不抛异常', () => {
    const hostile: unknown[] = [
      null,
      [],
      '',
      { id: {}, name: [], version: 0, apiVersion: null, capabilities: {}, entry: 1 },
      { entry: { core: {} } },
      Object.create(null) as Record<string, unknown>,
      { id: 'acme.hello'.repeat(500), capabilities: new Array(1000).fill('tools') },
    ]

    for (const raw of hostile) {
      expect(() => parsePluginManifest(raw)).not.toThrow()
      expect(parsePluginManifest(raw).ok).toBe(false)
    }
  })
})

describe('必填字段与类型', () => {
  it('空对象一次性报出全部缺失字段', () => {
    expect(codesOf({})).toEqual(new Array(6).fill('missing_field'))
    expect(diagnosticsOf({}).map((item) => item.field)).toEqual([
      'id',
      'name',
      'version',
      'apiVersion',
      'capabilities',
      'entry',
    ])
  })

  it('显式 null 等同缺失', () => {
    expectSingle(validManifest({ name: null }), 'missing_field', 'name')
  })

  it.each([
    ['id', 42],
    ['name', ['Hello']],
    ['version', 1.4],
    ['apiVersion', true],
  ])('字段 %s 类型不对报 invalid_type', (field, value) => {
    expectSingle(validManifest({ [field]: value }), 'invalid_type', field)
  })

  it.each([
    ['空串', ''],
    ['纯空白', '   '],
    ['超长', 'x'.repeat(81)],
    ['含控制字符', 'He\u0000llo'],
  ])('name %s 报 invalid_value', (_label, value) => {
    expectSingle(validManifest({ name: value }), 'invalid_value', 'name')
  })

  it('不短路：多个字段同时出错时一次报全', () => {
    expect(codesOf(validManifest({ id: 'Bad', capabilities: 'hooks', entry: {} }))).toEqual([
      'invalid_id',
      'invalid_type',
      'entry_empty',
    ])
  })
})

describe('id 身份规则（复用 R5）', () => {
  it.each(['single', 'Acme.Hello', 'acme..hello', '1acme.hello', 'acme.hello_x', 'a.b'])(
    'id %s 报 invalid_id',
    (id) => {
      expectSingle(validManifest({ id }), 'invalid_id', 'id')
    },
  )

  // R5 的正则允许段尾连字符（`[a-z][a-z0-9-]{1,62}`）；这里逐字复用，不额外收紧。
  it.each(['acme.hello-', 'acme-.hello'])('R5 允许的边缘写法 %s 仍然通过', (id) => {
    expect(parsePluginManifest(validManifest({ id })).ok).toBe(true)
  })

  it.each(['core.timeline', 'web-agent.tools'])('保留前缀 %s 报 reserved_id_prefix', (id) => {
    expectSingle(validManifest({ id }), 'reserved_id_prefix', 'id')
  })

  it.each(['acme.hello', 'io.example.my-plugin', 'a1.b2.c3'])('合法 id %s 通过', (id) => {
    expect(parsePluginManifest(validManifest({ id })).ok).toBe(true)
  })
})

describe('version 与 apiVersion', () => {
  it('version 含非 ASCII 报 invalid_version', () => {
    expectSingle(validManifest({ version: '一点四' }), 'invalid_version', 'version')
  })

  it('version 超长报 invalid_value', () => {
    expectSingle(validManifest({ version: '1'.repeat(65) }), 'invalid_value', 'version')
  })

  it.each(['v1', '1.2.3.4', '1.2.3-beta', '01.2', '1.', 'latest', '10000', '1.2.3+build'])(
    'apiVersion %s 报 invalid_api_version',
    (apiVersion) => {
      expectSingle(validManifest({ apiVersion }), 'invalid_api_version', 'apiVersion')
    },
  )
})

describe('capabilities 枚举', () => {
  it('未知值报 unknown_capability 并带下标', () => {
    expectSingle(
      validManifest({ capabilities: ['hooks', 'filesystem'] }),
      'unknown_capability',
      'capabilities[1]',
    )
  })

  it('数组元素不是字符串报 invalid_type', () => {
    expectSingle(validManifest({ capabilities: [{ tools: true }] }), 'invalid_type', 'capabilities[0]')
  })

  it('非数组报 invalid_type', () => {
    expectSingle(validManifest({ capabilities: 'hooks' }), 'invalid_type', 'capabilities')
  })

  it('元素过多报 invalid_value', () => {
    expectSingle(
      validManifest({ capabilities: new Array(33).fill('tools') }),
      'invalid_value',
      'capabilities',
    )
  })
})

describe('entry 声明', () => {
  it.each([{}, { core: null, react: null }, { other: 'x.js' }])(
    'core 与 react 全空报 entry_empty',
    (entry) => {
      expectSingle(validManifest({ entry }), 'entry_empty', 'entry')
    },
  )

  it.each([['非对象', 'core.js'], ['数组', ['core.js']]])('entry %s 报 invalid_entry', (_label, entry) => {
    expectSingle(validManifest({ entry }), 'invalid_entry', 'entry')
  })

  it.each([[42], [{}], [['core.js']], [''], ['   '], ['a'.repeat(257)], ['core\u0000.js']])(
    'entry.core 值 %s 报 invalid_entry',
    (core: unknown) => {
      expectSingle(validManifest({ entry: { core } }), 'invalid_entry', 'entry.core')
    },
  )

  it.each([
    '/abs/core.js',
    '../escape.js',
    'dist/../../escape.js',
    'https://evil.example/core.js',
    'file:///etc/passwd',
    'C:/plugins/core.js',
    'dist\\core.js',
    'dist//core.js',
    './',
    'dist/./core.js',
  ])('逃逸路径 %s 报 unsafe_entry_path', (core) => {
    expectSingle(validManifest({ entry: { core } }), 'unsafe_entry_path', 'entry.core')
  })

  it('react 入口同样受路径约束', () => {
    expectSingle(validManifest({ entry: { react: '../ui.js' } }), 'unsafe_entry_path', 'entry.react')
  })
})
