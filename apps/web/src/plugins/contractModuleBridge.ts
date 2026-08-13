// apps/web/src/plugins/contractModuleBridge.ts —— 把宿主自己的契约模块实例做成可被插件 import 的模块
// ---------------------------------------------------------------------------
// 只负责一件事：给定「说明符 → 宿主已加载的模块命名空间」，产出一个 blob 模块 URL，
// 让 blob 里求值的插件能 `import { definePlugin } from '<那个 URL>'` 拿到【同一份实例】。
// 谁把插件源码里的裸说明符换成这个 URL 是 contractImportRewrite.ts 的事。
//
// 为什么需要它：浏览器只能经【页面的 import map】解析裸说明符，而桌面壳的页面是 Vite 打包产物，
// 根本不存在「`@web-agent/core/plugin` 对应哪个 URL」这种东西——公开面被打进了应用 chunk，
// 没有独立文件可指。所以宿主必须把手里的模块实例反向暴露成一个 URL，这是唯一不需要改打包
// 形态的做法（另外两条候选：给页面注入 import map 仍要有 URL 可指、把契约代码复制进 blob 会
// 造出第二份实例与第二套状态，都更差）。
//
// 传递方式：blob 的源码是字符串，闭包捞不到宿主对象，只能经 globalThis 交接。生成的模块在
// 求值时把命名空间读走，之后插件拿到的都是普通模块绑定。这个全局不是新的信任面——插件与页面
// 同权，本来就能直接触达 globalThis 上的一切（见 desktopImportModule.ts 顶部注释）。

import * as corePluginContract from '@web-agent/core/plugin'

/** 交接用的全局键。带前后下划线以示「宿主内部实现细节，不是给插件读的公开面」。 */
export const CONTRACT_MODULE_GLOBAL_KEY = '__webAgentPluginContractModules__'

/** 合法 JS 标识符；命名空间里非标识符的导出名（ES2022 的字符串导出名）不桥接。 */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** 重写器需要的最小面：问「这个说明符宿主给不给实例」，给就取一个可求值的 URL。 */
export interface ContractModuleResolver {
  /** 宿主能提供实例的说明符清单；重写器只动这些说明符，别的一律原样放过。 */
  readonly specifiers: readonly string[]
  /** 取该说明符对应的模块 URL；按需构造并缓存，源码里没出现就不会被调用。 */
  urlFor(specifier: string): string
}

/**
 * 桌面宿主默认桥接的契约模块。
 *
 * 只有 `@web-agent/core/plugin` 一条：它是 core 的唯一公开入口（packages/agent-core/src/plugin.ts
 * 首行），也是 docs/plugin-quickstart.md 教插件作者写的唯一 import。`@web-agent/react-plugin`
 * 暂不在列——今天没有任何宿主装 `entry.react`（pluginLoader 只装 core 入口），先桥一个没人用的
 * 说明符等于在无从验证的路径上留代码；等 react 入口真接线时在这里加一行即可。
 */
export const DEFAULT_CONTRACT_MODULES: Readonly<Record<string, object>> = Object.freeze({
  '@web-agent/core/plugin': corePluginContract,
})

let tokenSeq = 0

type ContractRegistry = Record<string, object>

function registry(): ContractRegistry {
  const holder = globalThis as unknown as Record<string, ContractRegistry | undefined>
  const existing = holder[CONTRACT_MODULE_GLOBAL_KEY]
  if (existing) return existing
  const created: ContractRegistry = Object.create(null) as ContractRegistry
  holder[CONTRACT_MODULE_GLOBAL_KEY] = created
  return created
}

/**
 * 生成桥模块源码：把命名空间的每个导出重新导出一遍。
 *
 * 用 `export { __x0 as name }` 而不是 `export const name = ...`，是为了让 `default` 和保留字
 * 导出名（`export { x as new }` 合法）走同一条路，不必为它们分叉。
 * 取的是求值时刻的快照而非 live binding——契约模块导出的是冻结常量与函数，没有可变绑定。
 */
export function buildContractModuleSource(specifier: string, token: string, exportNames: readonly string[]): string {
  const names = exportNames.filter((name) => IDENTIFIER.test(name))
  const missing = `插件契约模块 ${specifier} 未在宿主注册，无法解析`
  return [
    `const contracts = globalThis[${JSON.stringify(CONTRACT_MODULE_GLOBAL_KEY)}]`,
    `const ns = contracts && contracts[${JSON.stringify(token)}]`,
    `if (!ns) throw new Error(${JSON.stringify(missing)})`,
    ...names.map((name, index) => `const __x${index} = ns[${JSON.stringify(name)}]`),
    `export { ${names.map((name, index) => `__x${index} as ${name}`).join(', ')} }`,
    '',
  ].join('\n')
}

export interface ContractModuleBridgeOptions {
  /** 覆盖桥接的模块表（测试注入假命名空间）；缺省是 DEFAULT_CONTRACT_MODULES。 */
  modules?: Readonly<Record<string, object>>
}

/**
 * 造一个契约模块桥。
 *
 * 生成的 blob URL 【不回收】：插件模块按 URL 引用它，且同一说明符全应用共用一个，
 * 数量上限就是桥接的说明符个数（当前 1 个），不随插件数量增长。回收它反而会让后续插件
 * 或已加载插件的再次 import 解析失败。
 */
export function createContractModuleBridge(options: ContractModuleBridgeOptions = {}): ContractModuleResolver {
  const modules = options.modules ?? DEFAULT_CONTRACT_MODULES
  const urls = new Map<string, string>()

  return {
    specifiers: Object.keys(modules),
    urlFor(specifier) {
      const cached = urls.get(specifier)
      if (cached) return cached
      const namespace: object | undefined = modules[specifier]
      // 只会在调用方越过 specifiers 清单时发生：如实报错，别造一个求值即崩的模块。
      if (!namespace) throw new Error(`宿主没有注册契约模块 ${specifier}`)

      const token = `${specifier}#${(tokenSeq += 1)}`
      registry()[token] = namespace
      const source = buildContractModuleSource(specifier, token, Object.keys(namespace))
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      urls.set(specifier, url)
      return url
    },
  }
}

let defaultBridge: ContractModuleResolver | undefined

/** 全应用共用的默认桥：同一说明符只造一次模块实例，插件之间共享 definePlugin 的同一份品牌。 */
export function defaultContractModuleBridge(): ContractModuleResolver {
  defaultBridge ??= createContractModuleBridge()
  return defaultBridge
}
