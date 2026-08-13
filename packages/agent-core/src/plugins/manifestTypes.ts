// agent-core/plugins/manifestTypes.ts —— 插件 manifest 的契约类型与常量
// ---------------------------------------------------------------------------
// 本文件只声明「manifest 长什么样」：类型、枚举、正则与上限常量。
// 解析与兼容判定在 manifest.ts，两者都不做 IO、不依赖宿主。
//
// 字段约束来自 docs/plugin-ecosystem-blueprint.md 第 3.2 节；身份规则（id 正则与
// 禁用前缀）直接复用 docs/persistent-plugin-timeline-item-rfc.md 第 3 节，不做修改。

/** 插件可申报的能力面。第一期是「申报」而非沙箱，不得在 UI 上暗示它有强制力。 */
export const PLUGIN_CAPABILITIES = [
  'tools',
  'hooks',
  'commands',
  'renderer',
  'timeline.persist',
] as const

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number]

/**
 * 自定义持久化 timeline item 的能力。
 * 解析层允许申报，但 R5 RFC 未获批准前宿主必须一律拒绝授予（蓝图第 7 节）。
 */
export const TIMELINE_PERSIST_CAPABILITY = 'timeline.persist' satisfies PluginCapability

/**
 * 入口声明：core 与 react 必须分开写，对齐 renderer 协议「两套独立安装面」的既有结论。
 * 至少要有一个；值是插件目录内的相对 POSIX 路径。
 */
export interface PluginEntryPoints {
  readonly core?: string
  readonly react?: string
}

/** 解析并归一化后的 manifest。只有 parsePluginManifest 会产出它。 */
export interface PluginManifest {
  /** 反向域名 namespace，复用 R5 的 plugin.id 规则。 */
  readonly id: string
  /** 展示名，诊断与设置页用。 */
  readonly name: string
  /** 展示版本；不属于信任边界，不参与任何兼容判定。 */
  readonly version: string
  /** 插件面向的 API 版本，已归一化为 `x.y.z`。 */
  readonly apiVersion: string
  /** 去重并按 PLUGIN_CAPABILITIES 顺序稳定排序后的申报能力。 */
  readonly capabilities: readonly PluginCapability[]
  readonly entry: PluginEntryPoints
  /**
   * 是否申报了 `timeline.persist`。单独抬出来，方便上层无需再解析 capabilities
   * 就能执行「一律拒绝授予」。
   */
  readonly requestsTimelinePersist: boolean
}

/** 结构化诊断的 code 全集；坏输入一律映射到其中之一，不抛异常。 */
export const MANIFEST_DIAGNOSTIC_CODES = [
  /** 顶层不是普通对象（null / 数组 / 标量 / JSON 解析后的非对象）。 */
  'not_an_object',
  /** 必填字段缺失（含显式 null）。 */
  'missing_field',
  /** 字段的 JS 类型不对（期望 string / array / object）。 */
  'invalid_type',
  /** 类型对但值不满足约束（空串、超长、控制字符）。 */
  'invalid_value',
  /** id 不匹配 R5 正则。 */
  'invalid_id',
  /** id 落在保留前缀 `core.` / `web-agent.` 上。 */
  'reserved_id_prefix',
  /** version 不是可展示的 ASCII 文本。 */
  'invalid_version',
  /** apiVersion 不是 `x` / `x.y` / `x.y.z` 形状的数字版本。 */
  'invalid_api_version',
  /** capabilities 里出现枚举外的值。 */
  'unknown_capability',
  /** entry 不是对象，或 core / react 的值类型不对。 */
  'invalid_entry',
  /** entry 路径逃出插件目录（绝对路径、scheme、反斜杠、`..` 段等）。 */
  'unsafe_entry_path',
  /** entry 里 core 与 react 都没声明。 */
  'entry_empty',
  /** 申报了当前宿主不会授予的能力（timeline.persist）。这是警告，不是解析失败。 */
  'capability_not_grantable',
  /** apiVersion 落在宿主支持区间之外 → 上层标 incompatible。 */
  'api_version_incompatible',
  /** 宿主自己给的支持区间不合法（宿主编程错误，同样不抛异常）。 */
  'host_range_invalid',
] as const

export type ManifestDiagnosticCode = (typeof MANIFEST_DIAGNOSTIC_CODES)[number]

/** 一条结构化诊断：机器读 code，人读中文 message。 */
export interface ManifestDiagnostic {
  readonly code: ManifestDiagnosticCode
  /** 出问题的字段路径，如 `entry.core`、`capabilities[1]`；顶层问题没有该字段。 */
  readonly field?: string
  readonly message: string
}

export interface ManifestParseSuccess {
  readonly ok: true
  readonly manifest: PluginManifest
  /** 解析成功但需要上层处理的提示，目前只有 `capability_not_grantable`。 */
  readonly warnings: readonly ManifestDiagnostic[]
}

export interface ManifestParseFailure {
  readonly ok: false
  /** 一次收齐所有问题，设置页可一屏列完，不用挤牙膏式反复修。 */
  readonly diagnostics: readonly ManifestDiagnostic[]
}

export type ManifestParseResult = ManifestParseSuccess | ManifestParseFailure

/** 宿主声明的 API 支持区间，两端都是闭区间。 */
export interface PluginApiVersionRange {
  readonly min: string
  readonly max: string
}

export type ApiVersionCompatibility =
  | { readonly compatible: true }
  | { readonly compatible: false; readonly diagnostic: ManifestDiagnostic }

/**
 * plugin.id：小写反向域名式 namespace。
 * 原文见 docs/persistent-plugin-timeline-item-rfc.md 第 3 节 `plugin.id` 行，逐字复用。
 */
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{1,62}(?:\.[a-z][a-z0-9-]{1,62})+$/

/** R5 同节规定的禁用前缀：这两个 namespace 归内核。 */
export const RESERVED_PLUGIN_ID_PREFIXES = ['core.', 'web-agent.'] as const

/**
 * apiVersion：`x` / `x.y` / `x.y.z`，各段 0–9999 且不允许前导零。
 * 不收 prerelease / build 元数据——它们的排序规则会让区间比较变成一个模糊判断，
 * 而这里的输出必须是「兼容 / 不兼容」的确定答案。
 */
export const API_VERSION_PATTERN = /^(0|[1-9]\d{0,3})(?:\.(0|[1-9]\d{0,3}))?(?:\.(0|[1-9]\d{0,3}))?$/

/** id 总长上限：远大于任何现实 id，纯粹是防病态输入，不改变 R5 的身份规则。 */
export const MAX_PLUGIN_ID_LENGTH = 255
export const MAX_PLUGIN_NAME_LENGTH = 80
/** 与 R5 的 packageVersion 上限对齐（64 字节 ASCII）。 */
export const MAX_PLUGIN_VERSION_LENGTH = 64
export const MAX_API_VERSION_LENGTH = 32
export const MAX_ENTRY_PATH_LENGTH = 256
/** capabilities 数组的元素上限：枚举本身就那么几个，多出来的必是脏数据。 */
export const MAX_CAPABILITY_ENTRIES = 32
