// agent-core/plugins/pluginLoader.ts —— 动态加载与安装的编排
// ---------------------------------------------------------------------------
// 输入 P3 扫描器的 ScannedPlugin[]，对每一项走：
//   apiVersion 判定 → 经注入的 importModule 动态导入 → branded 导出校验 → 工具闸门 →
//   安装进 plugin host 拿 disposer
// 输出与入参一一对应的结构化结果（见 pluginLoaderTypes.ts 的状态机）。
//
// 两条硬纪律：
// 1) core 不碰 IO——importModule 是注入依赖，宿主自己决定 file URL import 还是 blob 求值。
// 2) 错误隔离——单个插件的任何失败都降级为该项的 failed/incompatible + 诊断，
//    绝不抛出、绝不影响其余插件与启动流程（docs/plugin-ecosystem-blueprint.md 第 3.3 节）。

import { checkApiVersionCompatibility } from './apiVersion'
import { PLUGINS_DIR } from './pluginScanner'
import { resolveCorePluginExport } from './pluginModuleExports'
import { gatePluginTools, withheldToolsDiagnostic } from './pluginToolGate'
import {
  TOP_LEVEL_SIDE_EFFECT_TODO,
  type LoadedPlugin,
  type PluginLoadResult,
  type PluginLoaderDeps,
} from './pluginLoaderTypes'
import { TIMELINE_PERSIST_CAPABILITY, type PluginCapability, type PluginManifest } from './manifestTypes'
import type { ScannedPlugin } from './pluginScanner'

const denyAllTools = () => false

/**
 * 加载一批已扫描到的插件。
 *
 * 顺序执行而不是并发：id 去重与诊断顺序才可预期，且加载本身是一次性启动成本。
 * 返回的 plugins 与入参等长、同序；只有 status === 'enabled' 的项带 dispose。
 */
export async function loadScannedPlugins(
  scanned: readonly ScannedPlugin[],
  deps: PluginLoaderDeps,
): Promise<PluginLoadResult> {
  const plugins: LoadedPlugin[] = []
  const claimedIds = new Map<string, string>()

  for (const item of scanned) {
    try {
      plugins.push(await loadOne(item, deps, claimedIds))
    } catch (error) {
      // 兜底：loadOne 内部已按步骤捕获，这里只防「结果构造本身出意外」（如冻结对象取值抛错）。
      plugins.push(failure(item, [`${item.dirName}: 加载时发生未预期错误 — ${messageOf(error)}`]))
    }
  }

  return { plugins, unverified: [TOP_LEVEL_SIDE_EFFECT_TODO] }
}

async function loadOne(
  item: ScannedPlugin,
  deps: PluginLoaderDeps,
  claimedIds: Map<string, string>,
): Promise<LoadedPlugin> {
  const diagnostics = [...item.diagnostics]

  // 扫描期就无效的项照样留在结果里：设置页要能解释「这个目录为什么没生效」。
  if (!item.manifestResult?.ok) {
    return failure(item, [...diagnostics, `${item.dirName}: manifest 无效，未加载`])
  }
  const manifest = item.manifestResult.manifest
  const identity = { id: manifest.id, name: manifest.name, version: manifest.version }

  const deniedCapabilities = deniedCapabilitiesOf(manifest)
  if (deniedCapabilities.length > 0) {
    // 一律拒绝授予，且不因此拒绝整个插件：manifest 解析层把它定为 warning 而非错误。
    diagnostics.push(
      `${manifest.id}: 已拒绝授予 ${deniedCapabilities.join('、')} 能力（R5 未批准，宿主不提供该面）`,
    )
  }

  const claimedBy = claimedIds.get(manifest.id)
  if (claimedBy !== undefined) {
    return failure(item, [
      ...diagnostics,
      `${manifest.id}: 插件 id 与目录 ${claimedBy} 重复，已跳过——id 是身份，不允许两个目录同时认领`,
    ], identity, deniedCapabilities)
  }
  claimedIds.set(manifest.id, item.dirName)

  const compatibility = checkApiVersionCompatibility(manifest, deps.apiVersionRange)
  if (!compatibility.compatible) {
    const line = `${manifest.id}: ${compatibility.diagnostic.message}`
    // 宿主自己把支持区间配错了，不是插件不兼容：归 failed，别把宿主的配置错误写在插件账上。
    const status = compatibility.diagnostic.code === 'host_range_invalid' ? 'failed' : 'incompatible'
    return { ...base(item, identity, [...diagnostics, line], deniedCapabilities), status }
  }

  const entry = manifest.entry.core
  if (entry === undefined) {
    return {
      ...base(item, identity, [
        ...diagnostics,
        `${manifest.id}: 未声明 core 入口，本加载器只装 core 侧入口（react 入口由 UI 宿主另行装配）`,
      ], deniedCapabilities),
      status: 'incompatible',
    }
  }
  const entryPath = `${PLUGINS_DIR}/${item.dirName}/${entry}`

  let moduleNamespace: unknown
  try {
    moduleNamespace = await deps.importModule(entryPath)
  } catch (error) {
    return failure(item, [
      ...diagnostics,
      `${manifest.id}: 导入 ${entryPath} 失败 — ${messageOf(error)}`,
    ], identity, deniedCapabilities, entryPath)
  }

  const exported = resolveCorePluginExport(moduleNamespace)
  if (!exported.ok) {
    return failure(item, [
      ...diagnostics,
      `${manifest.id}: ${exported.reason}`,
    ], identity, deniedCapabilities, entryPath)
  }

  const gated = gatePluginTools(exported.plugin, {
    pluginId: manifest.id,
    declaresToolsCapability: manifest.capabilities.includes('tools'),
    isToolEnabled: deps.isToolEnabled?.bind(deps) ?? denyAllTools,
  })

  let installation: { dispose: () => void }
  try {
    installation = deps.host.installPlugin(gated.plugin, identity)
  } catch (error) {
    // 安装期预检失败（工具重名等）：host 已原子回滚本次注册，这里只记账。
    return failure(item, [
      ...diagnostics,
      ...gated.outcome.diagnostics,
      `${manifest.id}: 安装失败 — ${messageOf(error)}`,
    ], identity, deniedCapabilities, entryPath)
  }

  const withheldLine = withheldToolsDiagnostic(manifest.id, gated.outcome.withheld)
  return {
    ...base(item, identity, [
      ...diagnostics,
      ...gated.outcome.diagnostics,
      ...(withheldLine ? [withheldLine] : []),
    ], deniedCapabilities, entryPath),
    status: 'enabled',
    grantedTools: [...gated.outcome.granted],
    withheldTools: [...gated.outcome.withheld],
    dispose: installation.dispose,
  }
}

type Identity = { id: string; name: string; version: string }

function base(
  item: ScannedPlugin,
  identity: Identity | undefined,
  diagnostics: readonly string[],
  deniedCapabilities: readonly PluginCapability[],
  entryPath?: string,
): Omit<LoadedPlugin, 'status'> {
  return {
    dirName: item.dirName,
    ...(identity ?? {}),
    ...(entryPath ? { entryPath } : {}),
    diagnostics,
    grantedTools: [],
    withheldTools: [],
    deniedCapabilities,
  }
}

function failure(
  item: ScannedPlugin,
  diagnostics: readonly string[],
  identity?: Identity,
  deniedCapabilities: readonly PluginCapability[] = [],
  entryPath?: string,
): LoadedPlugin {
  return { ...base(item, identity, diagnostics, deniedCapabilities, entryPath), status: 'failed' }
}

function deniedCapabilitiesOf(manifest: PluginManifest): readonly PluginCapability[] {
  return manifest.requestsTimelinePersist ? [TIMELINE_PERSIST_CAPABILITY] : []
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
