// apps/web/src/plugins/desktopImportModule.ts —— 桌面宿主的插件入口求值
// ---------------------------------------------------------------------------
// P4 的 loader 只声明「给我一个把 entryPath 变成模块的函数」（pluginLoaderTypes.ts 的
// importModule），怎么变是宿主的事。桌面这条按蓝图 3.4 的桌面行走：
// Rust 侧读文件 → 前端 blob URL → 动态 import 求值。
//
// 【CSP】apps/desktop/tauri.conf.json 的 app.security.csp 目前是 null（Tauri 不注入任何
// CSP 头），apps/web/index.html 也没有 <meta http-equiv="Content-Security-Policy">，
// 因此 blob: 脚本求值不受策略拦截。将来若给桌面壳加 CSP，必须同时放行 script-src blob:，
// 否则本文件这条路径会被静默挡死。
//
// 【这是在渲染进程里执行第三方代码】与页面同权：可触达 Tauri IPC、DOM、fetch。
// manifest 的 capabilities 是申报不是沙箱（蓝图 3.4 已写明），这里不做任何隔离伪装。
//
// 【插件入口必须是自包含的单文件 ESM】blob URL 没有可用的相对路径基准，模块内的
// `import './other.js'` 解析不到任何东西。同一约束在 CLI 侧表现为「必须自带 Node 可直接
// 消费的 ESM」，两个宿主对插件作者的要求方向一致。
//
// 【裸说明符 `@web-agent/core/plugin`】（P11）浏览器只能经页面的 import map 解析裸说明符，
// 而打包后的页面根本没有可指的 URL。所以求值前先把契约说明符改写成宿主自己的模块桥 URL
// （contractModuleBridge.ts + contractImportRewrite.ts），插件因此拿到与应用【同一份】
// definePlugin。品牌那半边由 pluginContracts.ts 的 Symbol.for 兜底，两者互不依赖：
// 桥保证「解析得到」，全局 Symbol 保证「即使换了实例也认得出」。

import type { PluginLoaderDeps } from '@web-agent/core'
import { readWorkspaceFile } from '@web-agent/core/runtime/workspaceRead'
import { rewriteContractImports } from './contractImportRewrite'
import { defaultContractModuleBridge, type ContractModuleResolver } from './contractModuleBridge'

/** 单个插件入口最多读多少字节。远大于任何合理的打包产物，纯粹防病态输入。 */
export const PLUGIN_ENTRY_READ_LIMIT = 2 * 1024 * 1024

export interface DesktopImportModuleOptions {
  /**
   * 求值一个 blob URL，默认原生动态 import。
   * 留出这个缝只为测试：jsdom 不实现 blob URL 的 ESM 求值，真机路径无从在单测里跑。
   */
  evaluate?: (url: string) => Promise<unknown>
  /** 覆盖契约模块桥（测试注入假命名空间）；缺省是全应用共用的默认桥。 */
  contractBridge?: ContractModuleResolver
}

/**
 * 造一个绑定到某个 workspace root 的 importModule。
 *
 * 失败一律抛出（loader 会把它降级成该插件的 failed + 诊断，不影响其余插件）：
 * - 读文件失败：原样带上 workspaceRead 的错误文本，保真到 diagnostics
 * - 读到上限被截断：截断后的字节求值出来的是半个模块，宁可不装
 * - 契约说明符用了改写不了的形态（动态 import）：说清怎么改，不留到求值时才炸
 */
export function createDesktopImportModule(
  workspaceRoot: string,
  options: DesktopImportModuleOptions = {},
): PluginLoaderDeps['importModule'] {
  // @vite-ignore：URL 在运行期才产生，Vite 无从静态分析这条动态 import。
  const evaluate = options.evaluate ?? ((url: string) => import(/* @vite-ignore */ url) as Promise<unknown>)
  // 桥按需构造：没有插件要装时不该白造一个 blob 模块。
  const contractBridge = () => options.contractBridge ?? defaultContractModuleBridge()

  return async (entryPath) => {
    const result = await readWorkspaceFile({
      path: entryPath,
      maxBytes: PLUGIN_ENTRY_READ_LIMIT,
      workspaceRoot,
      // 插件目录在 workspace 内，走与项目 skills 相同的 confinement，不开外部路径。
      allowExternalPaths: false,
    })
    if (!result.ok) throw new Error(result.error)
    if (result.data.truncated) {
      throw new Error(
        `入口文件超过 ${PLUGIN_ENTRY_READ_LIMIT} 字节上限（已读 ${result.data.bytes} 字节即截断），未求值`,
      )
    }

    // 改写在 blob 之前：blob 一旦造出来就是求值输入，说明符改不了了。
    const { source } = rewriteContractImports(result.data.content, contractBridge())

    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    try {
      return await evaluate(url)
    } finally {
      // import() 兑现时模块已经取完并求值完（含 top-level await），此刻回收不会打断求值。
      // 不回收就是每装一次插件泄一份源码在文档生命周期里。
      URL.revokeObjectURL(url)
    }
  }
}
