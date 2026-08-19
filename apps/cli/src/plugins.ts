// apps/cli/src/plugins.ts —— CLI 宿主的插件扫描与加载装配
// ---------------------------------------------------------------------------
// P8 卡：把 P3 的 scanPlugins（目录扫描）与 P4 的 loadScannedPlugins（动态导入 + 安装）接到
// CLI 宿主。CLI 无 React root，只装 core 侧入口（docs/plugin-ecosystem-blueprint.md 3.4 节）；
// 外部插件必须自带 Node 可直接消费的 ESM——importModule 用原生 `import()`，不复刻仓库内的
// `?raw` / workspace alias magic（同节）。
//
// 工具勾选（docs/plugin-and-provider-issues.md「未决（已拍板）」拍板 3）：CLI 没有设置面板，
// 本卡不解析配置文件，isToolEnabled 缺省即 P4 的默认全关。CLI 侧经配置文件开放具体工具留给
// 后续卡（该卡未拆出前，勾选状态在 CLI 上恒为全关）。

import { pathToFileURL } from 'node:url'
import {
  defaultCore,
  loadScannedPlugins,
  scanPlugins,
  type PluginApiVersionRange,
  type PluginLoaderDeps,
  type PluginLoadResult,
  type PluginScanBridge,
} from '@einfach-agent/core'
import { buildNodeProjectSkillsBridge, resolveWorkspacePath } from './workspace-files'

/**
 * `loadCliPlugins` 的返回值：加载结果原样透传（`unverified` 保持 loader 文档承诺的恒定内容，
 * 不与其他诊断混装），扫描级诊断（列目录失败、子目录数截断）单独挂一个字段，供 -v 展示。
 */
export interface CliPluginResult {
  readonly load: PluginLoadResult
  readonly scanDiagnostics: readonly string[]
}

/**
 * 本卡声明的宿主 API 支持区间。当前插件生态只有 core 侧 v1.0.0 一个已知形状；
 * 后续卡若需要扩大区间，改这一处常量即可，扫描/加载逻辑本身不关心区间取值。
 */
const HOST_API_VERSION_RANGE: PluginApiVersionRange = { min: '1.0.0', max: '1.0.0' }

interface DiagnosticOutput {
  write(text: string): void
}

/**
 * 插件扫描用的文件系统桥。形状与 ProjectSkillsLoaderBridge 完全一致
 * （pluginScanner.ts 顶部注释即写明这是刻意的设计前提），直接复用既有 Node 桥，
 * 不为插件扫描单独实现一套 IO。
 */
function buildPluginScanBridge(): PluginScanBridge {
  return buildNodeProjectSkillsBridge()
}

/**
 * 把「插件目录内的相对 POSIX 路径」变成「可以塞进原生 import() 的 file URL」。
 * 复用 resolveWorkspacePath 的边界校验：manifest 解析层已经拒绝 `..`/绝对路径等形状，
 * 这里再做一层防御是纵深防御，不是重复劳动。
 */
function buildImportModule(workspaceRoot: string): PluginLoaderDeps['importModule'] {
  return async (entryPath) => {
    const absolute = resolveWorkspacePath(workspaceRoot, entryPath)
    return import(pathToFileURL(absolute).href)
  }
}

/**
 * 扫描 `<workspaceRoot>/.webAgent/plugins/` 并加载其中声明了 core 入口的插件，安装进
 * defaultCore 的 plugin host。
 *
 * 不抛出：scanPlugins 与 loadScannedPlugins 已经把逐插件失败（manifest 非法、import 抛错、
 * 安装期冲突……）降级为该项的 diagnostics，绝不影响其余插件或调用方（蓝图第 3.3 节）。
 */
export async function loadCliPlugins(workspaceRoot: string): Promise<CliPluginResult> {
  const bridge = buildPluginScanBridge()
  const scanResult = await scanPlugins(workspaceRoot, bridge)
  const deps: PluginLoaderDeps = {
    importModule: buildImportModule(workspaceRoot),
    host: defaultCore.plugins,
    apiVersionRange: HOST_API_VERSION_RANGE,
    // isToolEnabled 未提供 = P4 默认全关；CLI 本卡不解析配置文件，见文件头注释。
  }
  const load = await loadScannedPlugins(scanResult.plugins, deps)
  return { load, scanDiagnostics: scanResult.diagnostics }
}

/** `-v` 下把扫描级诊断与每个插件的状态/诊断打到 stderr，风格对齐 runtime.ts 的 configureTraceOutput。 */
function reportCliPluginDiagnostics(
  result: CliPluginResult,
  output: DiagnosticOutput,
): void {
  for (const diagnostic of result.scanDiagnostics) {
    output.write(`[plugins] ${diagnostic}\n`)
  }
  if (result.load.plugins.length === 0) {
    output.write('[plugins] 未发现插件\n')
    return
  }
  for (const plugin of result.load.plugins) {
    const label = plugin.id ? `${plugin.id}@${plugin.version}` : plugin.dirName
    output.write(`[plugins] ${label}: ${plugin.status}\n`)
    for (const diagnostic of plugin.diagnostics) {
      output.write(`[plugins]   ${diagnostic}\n`)
    }
  }
}

/**
 * 装配入口：供 `assembleCliRuntime` 调用。扫描 + 加载失败不阻塞 CLI 启动——
 * `loadCliPlugins` 本身已不抛出，这里的 try/catch 只防装配层自己的疏漏（如注入的 bridge/host
 * 形状不对）导致的意外异常，不能让一个坏插件目录拖垮整个 CLI 启动。
 */
export async function assembleCliPlugins(
  workspaceRoot: string,
  verbose: boolean,
  output: DiagnosticOutput = process.stderr,
): Promise<void> {
  try {
    const result = await loadCliPlugins(workspaceRoot)
    if (verbose) reportCliPluginDiagnostics(result, output)
  } catch (error) {
    if (!verbose) return
    const message = error instanceof Error ? error.message : String(error)
    output.write(`[plugins] 插件装配失败（已忽略，不阻塞启动）— ${message}\n`)
  }
}
