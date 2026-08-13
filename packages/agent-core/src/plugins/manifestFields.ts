// agent-core/plugins/manifestFields.ts —— manifest 单字段的校验与归一化
// ---------------------------------------------------------------------------
// 只负责一件事：把 unknown 的单个字段变成合法值，或往诊断数组里追加一条结构化诊断。
// 编排（哪些字段、失败如何汇总）在 manifest.ts；版本区间语义在 apiVersion.ts。
// 所有函数的失败路径都是「push 诊断 + 返回 undefined」，不抛异常。

import { formatApiVersion, parseApiVersionTriple } from './apiVersion'
import {
  MAX_API_VERSION_LENGTH,
  MAX_CAPABILITY_ENTRIES,
  MAX_ENTRY_PATH_LENGTH,
  MAX_PLUGIN_ID_LENGTH,
  MAX_PLUGIN_VERSION_LENGTH,
  PLUGIN_CAPABILITIES,
  PLUGIN_ID_PATTERN,
  RESERVED_PLUGIN_ID_PREFIXES,
  type ManifestDiagnostic,
  type ManifestDiagnosticCode,
  type PluginCapability,
  type PluginEntryPoints,
} from './manifestTypes'

export type Diagnostics = ManifestDiagnostic[]

// 控制字符（含 DEL）：会污染设置页展示与 trace，一律拒收。
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
// 可展示的 ASCII 文本：首字符不能是空格。
const DISPLAYABLE_ASCII = /^[!-~][ -~]*$/
// URL scheme（`https:`）与 Windows 盘符（`C:`）都会命中这条。
const PATH_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function pushDiagnostic(
  diagnostics: Diagnostics,
  code: ManifestDiagnosticCode,
  message: string,
  field?: string,
): undefined {
  diagnostics.push(field === undefined ? { code, message } : { code, field, message })
  return undefined
}

/** 取一个必填字段；缺失与显式 null 同等对待。 */
function requireField(
  record: Record<string, unknown>,
  field: string,
  diagnostics: Diagnostics,
): unknown {
  const value = record[field]
  if (value === undefined || value === null) {
    return pushDiagnostic(diagnostics, 'missing_field', `缺少必填字段 \`${field}\``, field)
  }
  return value
}

/** 必填文本字段的通用校验：类型、空串、超长、控制字符。返回 trim 后的值。 */
export function requireText(
  record: Record<string, unknown>,
  field: string,
  maxLength: number,
  diagnostics: Diagnostics,
): string | undefined {
  const value = requireField(record, field, diagnostics)
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    return pushDiagnostic(diagnostics, 'invalid_type', `字段 \`${field}\` 必须是字符串`, field)
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return pushDiagnostic(diagnostics, 'invalid_value', `字段 \`${field}\` 不能为空`, field)
  }
  if (trimmed.length > maxLength) {
    return pushDiagnostic(diagnostics, 'invalid_value', `字段 \`${field}\` 超过 ${maxLength} 个字符`, field)
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return pushDiagnostic(diagnostics, 'invalid_value', `字段 \`${field}\` 不能包含控制字符`, field)
  }
  return trimmed
}

export function parseIdField(
  record: Record<string, unknown>,
  diagnostics: Diagnostics,
): string | undefined {
  const raw = requireText(record, 'id', MAX_PLUGIN_ID_LENGTH, diagnostics)
  if (raw === undefined) return undefined

  if (!PLUGIN_ID_PATTERN.test(raw)) {
    return pushDiagnostic(
      diagnostics,
      'invalid_id',
      `插件 id \`${raw}\` 不合法：必须是小写反向域名且至少两段，如 \`acme.hello\``,
      'id',
    )
  }

  const reserved = RESERVED_PLUGIN_ID_PREFIXES.find((prefix) => raw.startsWith(prefix))
  if (reserved !== undefined) {
    return pushDiagnostic(
      diagnostics,
      'reserved_id_prefix',
      `插件 id \`${raw}\` 使用了保留前缀 \`${reserved}\`，该 namespace 归内核所有`,
      'id',
    )
  }
  return raw
}

export function parseVersionField(
  record: Record<string, unknown>,
  diagnostics: Diagnostics,
): string | undefined {
  const raw = requireText(record, 'version', MAX_PLUGIN_VERSION_LENGTH, diagnostics)
  if (raw === undefined) return undefined

  // version 只用于展示与诊断，不属于信任边界，所以不强制 SemVer；但必须是能安全显示的
  // ASCII 文本，避免把任意内容原样塞进设置页与 trace。
  if (!DISPLAYABLE_ASCII.test(raw)) {
    return pushDiagnostic(
      diagnostics,
      'invalid_version',
      '字段 `version` 必须是可显示的 ASCII 文本',
      'version',
    )
  }
  return raw
}

export function parseApiVersionField(
  record: Record<string, unknown>,
  diagnostics: Diagnostics,
): string | undefined {
  const raw = requireText(record, 'apiVersion', MAX_API_VERSION_LENGTH, diagnostics)
  if (raw === undefined) return undefined

  const triple = parseApiVersionTriple(raw)
  if (!triple) {
    return pushDiagnostic(
      diagnostics,
      'invalid_api_version',
      '字段 `apiVersion` 必须形如 `1`、`1.2` 或 `1.2.3`（各段 0–9999，无前导零，不支持预发布标记）',
      'apiVersion',
    )
  }
  return formatApiVersion(triple)
}

export function parseCapabilitiesField(
  record: Record<string, unknown>,
  diagnostics: Diagnostics,
): readonly PluginCapability[] | undefined {
  const value = requireField(record, 'capabilities', diagnostics)
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    return pushDiagnostic(diagnostics, 'invalid_type', '字段 `capabilities` 必须是数组', 'capabilities')
  }
  if (value.length > MAX_CAPABILITY_ENTRIES) {
    return pushDiagnostic(
      diagnostics,
      'invalid_value',
      `字段 \`capabilities\` 最多 ${MAX_CAPABILITY_ENTRIES} 项`,
      'capabilities',
    )
  }

  const declared = new Set<PluginCapability>()
  let failed = false
  value.forEach((entry: unknown, index: number) => {
    const field = `capabilities[${index}]`
    if (typeof entry !== 'string') {
      pushDiagnostic(diagnostics, 'invalid_type', `${field} 必须是字符串`, field)
      failed = true
      return
    }
    const capability = PLUGIN_CAPABILITIES.find((known) => known === entry)
    if (capability === undefined) {
      pushDiagnostic(
        diagnostics,
        'unknown_capability',
        `未知能力 \`${entry}\`，可选值：${PLUGIN_CAPABILITIES.join(' / ')}`,
        field,
      )
      failed = true
      return
    }
    declared.add(capability) // 重复申报同一能力不算错，去重即可。
  })
  if (failed) return undefined

  // 按枚举声明顺序稳定排序：manifest 哈希与设置页展示都不该受书写顺序影响。
  return PLUGIN_CAPABILITIES.filter((capability) => declared.has(capability))
}

/**
 * 入口路径必须是插件目录内的相对 POSIX 路径。
 * 这条边界是安全性的，不是洁癖——该路径之后会被拼到插件目录上去加载代码。
 */
function parseEntryPath(value: unknown, field: string, diagnostics: Diagnostics): string | undefined {
  if (typeof value !== 'string') {
    return pushDiagnostic(diagnostics, 'invalid_entry', `字段 \`${field}\` 必须是字符串`, field)
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_ENTRY_PATH_LENGTH || CONTROL_CHARACTERS.test(trimmed)) {
    return pushDiagnostic(diagnostics, 'invalid_entry', `字段 \`${field}\` 不是合法的入口路径`, field)
  }

  const normalized = trimmed.startsWith('./') ? trimmed.slice(2) : trimmed
  const segments = normalized.split('/')
  const unsafeSegment = segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  if (normalized.startsWith('/') || PATH_SCHEME.test(normalized) || normalized.includes('\\') || unsafeSegment) {
    return pushDiagnostic(
      diagnostics,
      'unsafe_entry_path',
      `字段 \`${field}\` 必须是插件目录内的相对路径，不能使用绝对路径、URL 或 \`..\``,
      field,
    )
  }
  return normalized
}

/** entry 的 core 与 react 必须分开声明，至少要有一个。 */
export function parseEntryField(
  record: Record<string, unknown>,
  diagnostics: Diagnostics,
): PluginEntryPoints | undefined {
  const value = requireField(record, 'entry', diagnostics)
  if (value === undefined) return undefined
  if (!isPlainRecord(value)) {
    return pushDiagnostic(diagnostics, 'invalid_entry', '字段 `entry` 必须是对象', 'entry')
  }

  const before = diagnostics.length
  const core = value.core === undefined || value.core === null
    ? undefined
    : parseEntryPath(value.core, 'entry.core', diagnostics)
  const react = value.react === undefined || value.react === null
    ? undefined
    : parseEntryPath(value.react, 'entry.react', diagnostics)
  if (diagnostics.length > before) return undefined

  if (core === undefined && react === undefined) {
    return pushDiagnostic(
      diagnostics,
      'entry_empty',
      '字段 `entry` 至少要声明 `core` 或 `react` 其中之一',
      'entry',
    )
  }
  return {
    ...(core === undefined ? {} : { core }),
    ...(react === undefined ? {} : { react }),
  }
}
