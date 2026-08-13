// agent-core/plugins/pluginScanner.ts —— 插件目录扫描器
// ---------------------------------------------------------------------------
// 扫 `<root>/.webAgent/plugins/<dir>/`，每个子目录找 plugin.json（或 package.json 的
// `webAgent` 字段，两种形状见 docs/plugin-ecosystem-blueprint.md 第 3.1 节），交给 P2 的
// parsePluginManifest 校验。
//
// 扫描先例照抄 tools/skills/src/projectSkillsLoader.ts：目录不存在不算错误、单条失败只记
// diagnostics 不影响其余、子目录数上限保护（蓝图第 3.3 节）。纯 IO 经注入的
// PluginScanBridge 完成——本文件不 import node:fs，core 不持有 IO 依赖，宿主经装配层注入
// 实现（形状对齐 runtime/core/projectSkillsStore.ts 的 ProjectSkillsLoaderBridge，
// 宿主可复用同一份 Node/Tauri bridge，无需为插件扫描单独实现一套）。

import { isPlainRecord } from './manifestFields'
import { parsePluginManifest } from './manifest'
import type { ManifestParseResult } from './manifestTypes'

const PLUGINS_DIR = '.webAgent/plugins'
const MANIFEST_FILE = 'plugin.json'
const PACKAGE_FILE = 'package.json'
/** 单份 manifest 最多读多少字节：远大于任何合理 plugin.json/package.json。 */
const MANIFEST_READ_LIMIT = 64 * 1024
/** 传给 bridge 的列表上限：只是防病态输入的安全网，真正的目录数上限由 maxPluginDirs 控制。 */
const BRIDGE_LIST_LIMIT = 4096

/** 子目录数上限的默认值：远超过任何现实插件集合，纯粹防病态输入。 */
export const DEFAULT_MAX_PLUGIN_DIRS = 64

/**
 * 插件扫描依赖的文件系统桥接口。
 * 形状与 ProjectSkillsLoaderBridge 一致：生产实现可原样复用宿主已有的 Node/Tauri bridge；
 * 测试 fake 此接口完成纯内存覆盖。
 */
export interface PluginScanBridge {
  listFiles(path: string, options: {
    recursive: boolean
    includeHidden: boolean
    maxEntries: number
    workspaceRoot: string
    allowExternalPaths: boolean
  }): Promise<{ entries: Array<{ path: string; type: string }> }>
  readFile(path: string, options: {
    maxBytes: number
    workspaceRoot: string
    allowExternalPaths: boolean
  }): Promise<{ content: string }>
}

export interface PluginScanOptions {
  /** 子目录数上限，超出截断并记诊断。默认 DEFAULT_MAX_PLUGIN_DIRS。 */
  maxPluginDirs?: number
}

export type ScannedPluginStatus = 'discovered' | 'invalid'

export interface ScannedPlugin {
  /** `.webAgent/plugins/` 下的子目录名。 */
  readonly dirName: string
  readonly status: ScannedPluginStatus
  /** 找到 manifest 的形状；两种候选都不存在时缺席。 */
  readonly manifestSource?: 'plugin.json' | 'package.json'
  /**
   * 只有实际把某个 unknown 值交给 parsePluginManifest 时才有值——manifest 文件缺失或
   * JSON 语法错误时没有可解析的输入，此字段缺席，原因写在 diagnostics 里。
   */
  readonly manifestResult?: ManifestParseResult
  /** 人类可读诊断：本层 IO/JSON 问题 + manifestResult 内诊断/警告的展开，供设置页直接展示。 */
  readonly diagnostics: readonly string[]
}

export interface PluginScanResult {
  readonly plugins: readonly ScannedPlugin[]
  /** 扫描级诊断：列目录失败（非"不存在"）、子目录数超限截断。与单个插件无关。 */
  readonly diagnostics: readonly string[]
}

/**
 * 扫描一个 workspace 下的 `.webAgent/plugins/`，返回每个子目录的扫描结果。
 *
 * 降级策略（对齐 scanProjectSkills）：
 * - 插件根目录不存在 → 返回空数组、零诊断（绝大多数 workspace 没有该目录）
 * - 根目录列表因其他原因失败 → 空数组 + 一条扫描级诊断
 * - 子目录数超过上限 → 按目录名排序后截断，记一条扫描级诊断
 * - 单个子目录的 manifest 缺失/JSON 坏/字段非法/bridge 读失败 → 该项 status: 'invalid'，
 *   不影响其余子目录
 */
export async function scanPlugins(
  root: string,
  bridge: PluginScanBridge,
  options?: PluginScanOptions,
): Promise<PluginScanResult> {
  const maxPluginDirs = options?.maxPluginDirs ?? DEFAULT_MAX_PLUGIN_DIRS

  let dirEntries: Array<{ path: string; type: string }>
  try {
    const result = await bridge.listFiles(PLUGINS_DIR, {
      recursive: false,
      includeHidden: false,
      maxEntries: BRIDGE_LIST_LIMIT,
      workspaceRoot: root,
      allowExternalPaths: false,
    })
    dirEntries = result.entries
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (isMissingPathError(message)) return { plugins: [], diagnostics: [] }
    return { plugins: [], diagnostics: [`${PLUGINS_DIR}: 列表失败 — ${message}`] }
  }

  const dirNames = dirEntries
    .filter((entry) => entry.type === 'directory')
    .map((entry) => entry.path.slice(PLUGINS_DIR.length + 1))
    .filter((name) => name.length > 0 && !name.includes('/'))
    .sort() // 目录列出顺序不保证稳定；排序让截断结果与测试都可预期。

  const scanDiagnostics: string[] = []
  let candidates = dirNames
  if (candidates.length > maxPluginDirs) {
    scanDiagnostics.push(
      `${PLUGINS_DIR}: 子目录数 ${candidates.length} 超过上限 ${maxPluginDirs}，已截断`,
    )
    candidates = candidates.slice(0, maxPluginDirs)
  }

  // 每个子目录彼此独立，最多两次 readFile（先试 plugin.json 再试 package.json）：并发发起。
  const plugins = await Promise.all(
    candidates.map((dirName) => scanPluginDir(root, bridge, dirName)),
  )

  return { plugins, diagnostics: scanDiagnostics }
}

type JsonReadOutcome =
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly message: string }

async function readJsonFile(
  root: string,
  bridge: PluginScanBridge,
  relativePath: string,
): Promise<JsonReadOutcome> {
  let content: string
  try {
    const result = await bridge.readFile(relativePath, {
      maxBytes: MANIFEST_READ_LIMIT,
      workspaceRoot: root,
      allowExternalPaths: false,
    })
    content = result.content
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return isMissingPathError(message) ? { kind: 'missing' } : { kind: 'error', message }
  }

  try {
    return { kind: 'ok', value: JSON.parse(content) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { kind: 'error', message: `JSON 解析失败 — ${message}` }
  }
}

async function scanPluginDir(
  root: string,
  bridge: PluginScanBridge,
  dirName: string,
): Promise<ScannedPlugin> {
  const pluginJson = await readJsonFile(root, bridge, `${PLUGINS_DIR}/${dirName}/${MANIFEST_FILE}`)
  if (pluginJson.kind === 'ok') {
    return buildScannedPlugin(dirName, 'plugin.json', pluginJson.value)
  }
  if (pluginJson.kind === 'error') {
    // plugin.json 存在但读取/解析失败：这是该目录的真实问题，不再尝试 package.json 形状。
    return {
      dirName,
      status: 'invalid',
      manifestSource: 'plugin.json',
      diagnostics: [`${dirName}/${MANIFEST_FILE}: ${pluginJson.message}`],
    }
  }

  // plugin.json 不存在，尝试 package.json 的 webAgent 字段（蓝图 3.1 的包插件形状）。
  const packageJson = await readJsonFile(root, bridge, `${PLUGINS_DIR}/${dirName}/${PACKAGE_FILE}`)
  if (packageJson.kind === 'missing') {
    return {
      dirName,
      status: 'invalid',
      diagnostics: [`${dirName}: 未找到 ${MANIFEST_FILE}，也未找到 ${PACKAGE_FILE}`],
    }
  }
  if (packageJson.kind === 'error') {
    return {
      dirName,
      status: 'invalid',
      manifestSource: 'package.json',
      diagnostics: [`${dirName}/${PACKAGE_FILE}: ${packageJson.message}`],
    }
  }

  const webAgentField = isPlainRecord(packageJson.value) ? packageJson.value.webAgent : undefined
  if (webAgentField === undefined) {
    return {
      dirName,
      status: 'invalid',
      manifestSource: 'package.json',
      diagnostics: [`${dirName}/${PACKAGE_FILE}: 缺少 \`webAgent\` 字段`],
    }
  }
  return buildScannedPlugin(dirName, 'package.json', webAgentField)
}

function buildScannedPlugin(
  dirName: string,
  manifestSource: 'plugin.json' | 'package.json',
  raw: unknown,
): ScannedPlugin {
  const manifestResult = parsePluginManifest(raw)
  const items = manifestResult.ok ? manifestResult.warnings : manifestResult.diagnostics
  const diagnostics = items.map((diagnostic) => {
    const field = diagnostic.field ? `${diagnostic.field}: ` : ''
    return `${dirName}: ${field}${diagnostic.message}`
  })
  return {
    dirName,
    status: manifestResult.ok ? 'discovered' : 'invalid',
    manifestSource,
    manifestResult,
    diagnostics,
  }
}

/**
 * 判定一次 IO 失败是否只是"路径不存在"。
 * 判据取自 tools/skills/src/projectSkillsLoader.ts 的 isMissingDirectoryError，并入
 * apps/cli/src/workspace-files.ts 与 Rust workspace_read.rs 两侧的错误文案（ENOENT /
 * "路径不可读取" / "路径不可访问"）。同一判据同时用于列目录与读文件：把"不存在"和"其他
 * 失败"分开，前者静默，后者才值得报告为诊断。
 */
function isMissingPathError(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('enoent')
    || normalized.includes('is not accessible')
    || normalized.includes('no such file')
    || normalized.includes('cannot find the path')
    || normalized.includes('cannot find the file')
    || normalized.includes('不可读取')
    || normalized.includes('不可访问')
}
