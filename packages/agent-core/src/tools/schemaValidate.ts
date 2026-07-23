// tools/schemaValidate.ts —— JSON Schema 子集的运行时校验器（纯函数，零依赖）。
//
// 背景：每个 Tool.inputSchema 目前只发给 model 看，运行时从不校验——execute() 里各工具手写
// asRecord + 逐字段 if 重复造轮子（write-file 的 mode 手动 clamp、rg-search 的 contextLines 手动
// clamp……），schema 里的 enum/minimum/maximum 跟手写校验是两套真相，迟早漂移。
// 本文件把 schema 本身变成唯一真相：调用方（未来是 tools/registry.ts 的 run()）传入
// tool.inputSchema + 原始 args，拿回「规范化后（含 default 填充）的合法参数」或「给 model 看的
// 中文错误列表」，工具的 execute() 因此可以删掉大半手写校验代码。
//
// 覆盖的关键字（够用为止，不求完整 JSON Schema 实现）：
//   type / required / properties / enum / const / minimum / maximum / minLength / maxLength /
//   minItems / maxItems / items / oneOf / additionalProperties / default。
// 未识别的关键字（如 description）一律忽略，不报错——向前兼容。
//
// minimum/maximum 是「钳位」语义，不是「拒绝」语义：number/integer 越界时把值拉回边界、记一条
// warning，校验仍然 ok:true——因为各工具 execute() 里本来就有等价的手写 clamp（rg-search 的
// contextLines、write-file 的 maxBytes、shell 的 timeoutMs……），schema 层如果对这些字段报错
// 拒绝，会让 model 给出的、原本完全可执行的自然值被硬拒绝、白烧一轮往返（这是曾经出现过的回归，
// 见 git 历史）。minLength/maxLength/minItems/maxItems 则维持「拒绝」语义——截断字符串/数组
// 会静默丢弃用户或模型给出的数据，比报错危险得多，不能类比数值钳位处理。
//
// oneOf 的语义简化：真实 JSON Schema 要求“恰好一个分支匹配”，但本仓库里 oneOf 只用来做
// const 判别的互斥联合（见 apply-patch 的 operations[].type），分支天然互斥，因此这里按
// “≥1 个分支通过即算通过、取第一个通过分支”处理（等价于 anyOf，但对判别式联合场景效果相同）。
// 当没有分支通过时，会尝试找出所有分支共享的 const 判别字段（如 `type`），据此给出比
// “贴 4 份 schema 错误”更可读、更可操作的定位信息。

/** JSON Schema 子集的类型标注。`[key: string]` 让未识别关键字（如 description）能安全透传。 */
export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null'
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: unknown[]
  const?: unknown
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  items?: JsonSchema
  oneOf?: JsonSchema[]
  additionalProperties?: boolean | JsonSchema
  default?: unknown
  [key: string]: unknown
}

/**
 * 成功 → 规范化（含 default 填充）后的参数；失败 → 给 model 看的中文错误列表（带字段路径）。
 * `warnings` 仅在成功分支上可能出现（可选字段）：记录「钳位」发生过的字段（见 minimum/maximum
 * 的处理说明），调用方（如 tools/registry.ts）可以选择性地把它拼进结果里回显给 model，也可以
 * 完全不读——不读不影响既有行为，这是一个纯增量字段。
 */
export type SchemaValidationResult<T = unknown> =
  | { ok: true; value: T; warnings?: string[] }
  | { ok: false; errors: string[] }

type PathSegment = string | number

/**
 * 用 schema 校验 input，返回规范化结果。
 *   · schema 为 undefined/null（工具没声明 schema）→ 原样放行，不做任何校验。
 *   · 校验全量收集错误（不是遇错即停），让 model 一轮就能看到所有问题并自我修正。
 *   · 返回的 value 是新对象/数组（不会原地修改 input），缺省字段按 schema.default 填充。
 *   · number/integer 的 minimum/maximum 是「钳位」语义（越界值被拉回边界并记一条 warning），
 *     不是「拒绝」语义——工具 execute() 里原本就有等价的手写 clamp（rg-search 的 contextLines、
 *     write-file 的 maxBytes、shell 的 timeoutMs……），schema 校验层如果对这些字段报错会让
 *     model 给出的、原本完全可执行的自然值（如 contextLines:10）被硬拒绝，白烧一轮往返。
 *     minLength/maxLength/minItems/maxItems 则维持报错语义：截断字符串或数组会静默丢弃
 *     用户/模型给出的数据，比报错危险得多，不能类比数值钳位处理。
 */
export function validateAgainstSchema<T = unknown>(
  schema: JsonSchema | Record<string, unknown> | undefined | null,
  input: unknown,
): SchemaValidationResult<T> {
  if (schema === undefined || schema === null) {
    return { ok: true, value: input as T }
  }
  const errors: string[] = []
  const warnings: string[] = []
  const value = validateValue(schema as JsonSchema, input, [], errors, warnings)
  if (errors.length > 0) {
    return { ok: false, errors }
  }
  if (warnings.length > 0) {
    return { ok: true, value: value as T, warnings }
  }
  return { ok: true, value: value as T }
}

// ---- 内部实现 --------------------------------------------------------------

function validateValue(
  schemaRaw: unknown,
  value: unknown,
  path: PathSegment[],
  errors: string[],
  warnings: string[],
): unknown {
  const schema: JsonSchema = schemaRaw && typeof schemaRaw === 'object' ? (schemaRaw as JsonSchema) : {}

  if (schema.default !== undefined && value === undefined) {
    value = cloneValue(schema.default)
  }

  if (schema.const !== undefined) {
    if (!deepEqual(value, schema.const)) {
      errors.push(
        `${formatPath(path)}: 期望固定值 ${describeLiteral(schema.const)}，实际是 ${describeValue(value)}`,
      )
      return value
    }
  }

  if (schema.enum !== undefined) {
    const options = schema.enum
    if (!options.some((option) => deepEqual(option, value))) {
      errors.push(
        `${formatPath(path)}: 期望取值为 ${options.map(describeLiteral).join(' | ')} 之一，实际是 ${describeValue(value)}`,
      )
      return value
    }
  }

  const effectiveType = inferType(schema)
  if (effectiveType) {
    if (!matchesType(effectiveType, value)) {
      errors.push(`${formatPath(path)}: 期望类型 ${effectiveType}，实际是 ${describeValue(value)}`)
      return value
    }
  }

  // oneOf 判别式联合：分支自带完整的 type/properties/required，优先级高于下面的通用结构递归。
  if (schema.oneOf !== undefined) {
    return validateOneOf(schema, value, path, errors, warnings)
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${formatPath(path)}: 字符串长度应 ≥ ${schema.minLength}，实际长度 ${value.length}`)
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${formatPath(path)}: 字符串长度应 ≤ ${schema.maxLength}，实际长度 ${value.length}`)
    }
    return value
  }

  if (typeof value === 'number') {
    let numericValue = value
    // 上界钳位、下界拒绝——两侧【故意不对称】，别顺手统一：
    //   · maximum 侧：各工具 execute() 里本来就有等价的手写 clamp（rg-search 的 contextLines
    //     Math.min、write-file 的 maxBytes Math.min），schema 层钳位与之同义，不改变既有行为。
    //   · minimum 侧：各工具对「低于下限」的既有处理【不是 clamp 而是 fallback 到默认值】——
    //     write-file.ts 的 normalizeMaxBytes、shell-*.ts 的 normalizePositiveInteger 写的都是
    //     `if (value <= 0) return DEFAULT`。若在这里把 0 钳成 minimum，工具的 fallback 分支就
    //     永远进不去：模型用「0 = 不限制」这个常见惯例传参时，write-file 的 maxBytes:0 会从
    //     「用 200KB 默认值」变成「1 字节上限」，apply-patch 的 expectedReplacements:0
    //     （表达「预期 0 处替换」）会被钳成 1 —— 参数被静默改成语义相反的值。
    //     故下界一律报错：让模型收到明确信号去重发，而不是拿一个被悄悄改过的参数去动文件。
    if (schema.minimum !== undefined && numericValue < schema.minimum) {
      errors.push(`${formatPath(path)}: 应 ≥ ${schema.minimum}，实际 ${numericValue}`)
    }
    if (schema.maximum !== undefined && numericValue > schema.maximum) {
      warnings.push(`${formatPath(path)} 超出上限 ${schema.maximum}，已钳位为 ${schema.maximum}`)
      numericValue = schema.maximum
    }
    return numericValue
  }

  if (Array.isArray(value)) {
    return validateArray(schema, value, path, errors, warnings)
  }

  if (value !== null && typeof value === 'object') {
    return validateObject(schema, value as Record<string, unknown>, path, errors, warnings)
  }

  // boolean / null（或未声明任何约束的裸值）：原样放行。
  return value
}

function validateObject(
  schema: JsonSchema,
  obj: Record<string, unknown>,
  path: PathSegment[],
  errors: string[],
  warnings: string[],
): Record<string, unknown> {
  const props = schema.properties ?? {}
  const propKeys = Object.keys(props)
  const requiredList = schema.required ?? []
  const out: Record<string, unknown> = {}

  for (const key of propKeys) {
    const childSchema = props[key]
    const childPath = [...path, key]
    const raw = obj[key]
    if (raw === undefined) {
      if (childSchema && childSchema.default !== undefined) {
        out[key] = cloneValue(childSchema.default)
      } else if (requiredList.includes(key)) {
        errors.push(
          `${formatPath(childPath)}: 缺少必填字段（期望 ${describeExpectation(childSchema ?? {})}）`,
        )
      }
      continue
    }
    out[key] = validateValue(childSchema, raw, childPath, errors, warnings)
  }

  // required 里列了、但 schema.properties 没声明的字段（少见，但 JSON Schema 允许）。
  for (const key of requiredList) {
    if (propKeys.includes(key)) continue
    if (obj[key] === undefined) {
      errors.push(`${formatPath([...path, key])}: 缺少必填字段`)
    }
  }

  const additional = schema.additionalProperties
  for (const key of Object.keys(obj)) {
    if (propKeys.includes(key)) continue
    const childPath = [...path, key]
    if (additional === false) {
      errors.push(`${formatPath(childPath)}: 出现未声明的额外字段（schema 未定义此字段）`)
      continue
    }
    if (additional && typeof additional === 'object') {
      out[key] = validateValue(additional, obj[key], childPath, errors, warnings)
      continue
    }
    // additionalProperties 为 true 或未声明（JSON Schema 默认允许额外字段）：原样透传。
    out[key] = obj[key]
  }

  return out
}

function validateArray(
  schema: JsonSchema,
  arr: unknown[],
  path: PathSegment[],
  errors: string[],
  warnings: string[],
): unknown[] {
  if (schema.minItems !== undefined && arr.length < schema.minItems) {
    errors.push(`${formatPath(path)}: 数组长度应 ≥ ${schema.minItems}，实际长度 ${arr.length}`)
  }
  if (schema.maxItems !== undefined && arr.length > schema.maxItems) {
    errors.push(`${formatPath(path)}: 数组长度应 ≤ ${schema.maxItems}，实际长度 ${arr.length}`)
  }
  const itemSchema = schema.items
  if (!itemSchema) return arr.slice()
  return arr.map((item, index) => validateValue(itemSchema, item, [...path, index], errors, warnings))
}

function validateOneOf(
  schema: JsonSchema,
  value: unknown,
  path: PathSegment[],
  errors: string[],
  warnings: string[],
): unknown {
  const branches = (schema.oneOf ?? []).filter((b): b is JsonSchema => !!b && typeof b === 'object')

  const attempts = branches.map((branch) => {
    const localErrors: string[] = []
    const localWarnings: string[] = []
    const normalized = validateValue(branch, value, path, localErrors, localWarnings)
    return { branch, localErrors, localWarnings, normalized }
  })

  const passed = attempts.find((attempt) => attempt.localErrors.length === 0)
  if (passed) {
    warnings.push(...passed.localWarnings)
    return passed.normalized
  }

  // 全部分支都没通过：找共同的 const 判别字段（如 operations[].type），给出针对性错误——
  // 要么定位到「判别字段本身取值不对」，要么把命中判别值的那一支的具体错误直接透传出去，
  // 而不是把 N 份 schema 的失败原因都堆给 model。
  const discriminatorKey = findDiscriminatorKey(branches)
  if (discriminatorKey && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const actual = (value as Record<string, unknown>)[discriminatorKey]
    const matchedIndex = branches.findIndex((branch) => {
      const propSchema = branch.properties?.[discriminatorKey]
      return (
        propSchema !== undefined &&
        typeof propSchema === 'object' &&
        Object.prototype.hasOwnProperty.call(propSchema, 'const') &&
        deepEqual((propSchema as JsonSchema).const, actual)
      )
    })
    if (matchedIndex >= 0) {
      errors.push(...attempts[matchedIndex].localErrors)
      warnings.push(...attempts[matchedIndex].localWarnings)
      return attempts[matchedIndex].normalized
    }
    const allowed = branches
      .map((branch) => (branch.properties?.[discriminatorKey] as JsonSchema | undefined)?.const)
      .filter((v) => v !== undefined)
    errors.push(
      `${formatPath([...path, discriminatorKey])}: 期望取值为 ${allowed.map(describeLiteral).join(' | ')} 之一，实际是 ${describeValue(actual)}`,
    )
    return value
  }

  errors.push(`${formatPath(path)}: 不满足 oneOf 中任何一种候选结构（共 ${branches.length} 种）`)
  return value
}

/** 找出所有分支共享、且各自都是 const 的属性名（判别式联合的判别字段）。找不到则 undefined。 */
function findDiscriminatorKey(branches: JsonSchema[]): string | undefined {
  if (branches.length === 0) return undefined
  const candidateKeys = Object.keys(branches[0].properties ?? {})
  for (const key of candidateKeys) {
    const allConst = branches.every((branch) => {
      const propSchema = branch.properties?.[key]
      return (
        propSchema !== undefined &&
        typeof propSchema === 'object' &&
        Object.prototype.hasOwnProperty.call(propSchema, 'const')
      )
    })
    if (allConst) return key
  }
  return undefined
}

function inferType(schema: JsonSchema): JsonSchema['type'] | undefined {
  if (typeof schema.type === 'string') return schema.type
  if (schema.properties !== undefined) return 'object'
  if (schema.items !== undefined) return 'array'
  return undefined
}

function matchesType(type: NonNullable<JsonSchema['type']>, value: unknown): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true
  }
}

/** 缺字段时给 model 一个「期望什么」的简短提示，拼进「缺少必填字段」的错误里。 */
function describeExpectation(schema: JsonSchema): string {
  if (schema.const !== undefined) return `固定值 ${describeLiteral(schema.const)}`
  if (schema.enum !== undefined) return `取值为 ${schema.enum.map(describeLiteral).join(' | ')} 之一`
  if (schema.oneOf !== undefined) return 'oneOf 中的某一种结构'
  const type = inferType(schema)
  return type ? `${type} 类型` : '一个值'
}

/** 字面量（const/enum 候选值）的可读展示：字符串带引号，其它走 JSON.stringify。 */
function describeLiteral(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 「实际拿到的值」的可读展示，用在错误信息里，帮 model 对比期望 vs 实际。 */
function describeValue(value: unknown): string {
  if (value === undefined) return '未提供'
  if (value === null) return 'null'
  if (Array.isArray(value)) return `数组（长度 ${value.length}）`
  switch (typeof value) {
    case 'string':
      return `字符串 ${JSON.stringify(truncate(value, 40))}`
    case 'number':
      return `数字 ${value}`
    case 'boolean':
      return `布尔值 ${value}`
    case 'object':
      return `对象 ${truncate(safeStringify(value), 80)}`
    default:
      return String(value)
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return '[无法序列化]'
  }
}

/** path 段拼接成 "operations[0].type" 这样的可读路径；根节点（path 为空）显示为「参数」。 */
function formatPath(path: PathSegment[]): string {
  if (path.length === 0) return '参数'
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`
    } else {
      out += out.length === 0 ? segment : `.${segment}`
    }
  }
  return out
}

/** default/额外属性透传值的浅拷贝防护——避免多次校验共享同一个 schema.default 对象引用。 */
function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value)) as T
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object)
    const bKeys = Object.keys(b as object)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  }
  return false
}
