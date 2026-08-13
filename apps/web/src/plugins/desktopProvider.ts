// apps/web/src/plugins/desktopProvider.ts —— 桌面宿主的 PluginSettingsProvider 实现
// ---------------------------------------------------------------------------
// P5 定义的注入面（types.ts 的 PluginSettingsProvider）在这里接上已交付的两段：
// P3 的 scanPlugins（扫 `.webAgent/plugins/`）与 P4 的 loadScannedPlugins（导入 + 安装）。
// 组织方式与 apps/cli/src/plugins.ts 对称——同样的 scanner、同样的 loader、同样的宿主
// API 区间，只有「怎么读文件」和「怎么求值模块」两处按宿主换实现。
//
// 文件系统桥直接复用项目 skills 那条 Tauri 通路（buildProjectSkillsWorkspaceBridge），
// pluginScanner.ts 的 PluginScanBridge 就是照着 ProjectSkillsLoaderBridge 的形状定的，
// 结构上完全兼容：Rust 侧不需要为插件扫描新增任何 command，`.webAgent/plugins/` 本就在
// workspace confinement 内可读。
//
// 装配（何时创建本 provider、workspace 换了怎么办）在 initialize.ts，本文件只管加载语义。

import {
  loadScannedPlugins,
  type PluginApiVersionRange,
  type PluginInstallHost,
  type PluginLoaderDeps,
  type PluginLoadResult,
  scanPlugins,
  type PluginScanBridge,
  type ScannedPlugin,
  defaultCore,
} from '@web-agent/core'
import { createDesktopImportModule } from './desktopImportModule'
import type { LoadedPlugin, PluginSettingsProvider, PluginToolGate } from './types'

/**
 * 本宿主声明的 apiVersion 支持区间。与 apps/cli/src/plugins.ts 的常量同值但各自持有：
 * 宿主装得下什么是各宿主自己的事实，CLI 与桌面能装的东西未必永远一致（桌面有 DOM/React，
 * CLI 没有），共享一份常量会把两件事绑成一件。
 */
const HOST_API_VERSION_RANGE: PluginApiVersionRange = { min: '1.0.0', max: '1.0.0' }

export interface DesktopPluginSettingsProviderOptions {
  /**
   * 扫描哪个 workspace。缺席 = 当前会话还没有 workspace root（桌面壳刚起、用户还没选目录），
   * 此时 load() 返回空清单：宿主仍然支持插件，只是没有可扫的目录，不该谎报「不支持」。
   */
  workspaceRoot?: string
  /** 覆盖文件系统桥（测试注入内存 fake；生产走项目 skills 的同一条 Tauri 通路）。 */
  bridge?: PluginScanBridge
  /** 覆盖模块求值（测试注入；生产走 blob URL 求值，见 desktopImportModule.ts）。 */
  importModule?: PluginLoaderDeps['importModule']
  /** 覆盖安装面（测试注入隔离的 plugin host；生产装进 defaultCore）。 */
  host?: PluginInstallHost
}

const EMPTY_LOAD_RESULT: PluginLoadResult = { plugins: [], unverified: [] }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 构造一条 failed 结果：provider 约定不抛异常，enable 的每条失败路径都落成这个形状。 */
function failedPlugin(dirName: string, diagnostic: string): LoadedPlugin {
  return {
    dirName,
    status: 'failed',
    diagnostics: [diagnostic],
    grantedTools: [],
    withheldTools: [],
    deniedCapabilities: [],
  }
}

export function createDesktopPluginSettingsProvider(
  options: DesktopPluginSettingsProviderOptions = {},
): PluginSettingsProvider {
  const { workspaceRoot } = options

  // 桥模块保持 dynamic import：projectSkillsProvider.ts 就是这么做的（把 Tauri 文件 API
  // 推迟到首次扫描），静态 import 会把它拽回主 chunk，白白让浏览器预览也背上这段代码。
  let bridgePromise: Promise<PluginScanBridge | undefined> | undefined
  const resolveBridge = async (): Promise<PluginScanBridge> => {
    if (options.bridge) return options.bridge
    bridgePromise ??= import('@web-agent/core/runtime/projectSkillsBridge').then(
      ({ buildProjectSkillsWorkspaceBridge }) => buildProjectSkillsWorkspaceBridge(),
    )
    const bridge = await bridgePromise
    // 只在非 Tauri 宿主发生（那时 buildProjectSkillsWorkspaceBridge 返回 undefined）。
    // 装配层不会在浏览器预览里造本 provider，走到这里说明装配被绕过了，如实报错。
    if (!bridge) throw new Error('当前宿主没有 workspace 文件系统通路，无法扫描插件目录')
    return bridge
  }

  const loaderDeps = (root: string, isToolEnabled: PluginToolGate): PluginLoaderDeps => ({
    importModule: options.importModule ?? createDesktopImportModule(root),
    host: options.host ?? defaultCore.plugins,
    apiVersionRange: HOST_API_VERSION_RANGE,
    // 勾选记录归 service 持有（types.ts 的注释），provider 原样把闸门交给 loader。
    isToolEnabled,
  })

  /**
   * 扫一遍插件根目录。扫描级诊断（列目录失败、子目录数截断）在 P5 的面板契约里没有落点，
   * 按后果分两路处理，不静默丢：
   * - 一个插件都没扫到却有诊断 = 这次扫描根本没成 → 抛出，面板显示错误态而不是「还没有插件」
   * - 扫到了插件同时有诊断（截断）→ 该有的插件照常展示，诊断进控制台，不假装清单是完整的
   */
  const scan = async (root: string): Promise<readonly ScannedPlugin[]> => {
    const result = await scanPlugins(root, await resolveBridge())
    if (result.diagnostics.length === 0) return result.plugins
    if (result.plugins.length === 0) throw new Error(result.diagnostics.join('；'))
    console.warn('[plugins] 扫描诊断：', result.diagnostics.join('；'))
    return result.plugins
  }

  return {
    // 桌面宿主恒支持插件：有没有可扫的目录是 workspace 的事实，不是宿主能力的事实。
    capabilities: { supported: true },

    async load(isToolEnabled) {
      if (!workspaceRoot) return EMPTY_LOAD_RESULT
      return loadScannedPlugins(await scan(workspaceRoot), loaderDeps(workspaceRoot, isToolEnabled))
    },

    async enable(dirName, isToolEnabled) {
      const root = workspaceRoot
      if (!root) {
        return failedPlugin(dirName, `${dirName}: 当前会话没有 workspace 根目录，无法加载插件`)
      }
      let scanned: ScannedPlugin | undefined
      try {
        // 重新扫一遍再装：用户可能在停用期间改过 manifest，拿旧快照重装等于装了个已经不存在的东西。
        scanned = (await scan(root)).find((item) => item.dirName === dirName)
      } catch (error) {
        return failedPlugin(dirName, `${dirName}: 扫描插件目录失败 — ${messageOf(error)}`)
      }
      if (!scanned) {
        return failedPlugin(dirName, `${dirName}: 已不在 .webAgent/plugins/ 下，无法加载`)
      }
      // loadScannedPlugins 按契约不抛出，且与入参等长同序：单项入参必得单项结果。
      const result = await loadScannedPlugins([scanned], loaderDeps(root, isToolEnabled))
      return result.plugins[0] ?? failedPlugin(dirName, `${dirName}: 加载器没有返回结果`)
    },
  }
}
