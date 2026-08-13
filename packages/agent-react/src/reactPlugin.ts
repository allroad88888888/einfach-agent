// React UI 插件的公开契约；只交给插件精确 renderer 注册能力。

import type {
  TimelineItemKind,
  TimelineRenderer,
} from './timelineRendererTypes'

/**
 * 与 core 品牌同规格的全局注册表 Symbol，理由见
 * packages/agent-core/src/runtime/core/pluginContracts.ts 的 publicPluginBrand：
 * 品牌是「防裸对象误装」的运行时判据，不是安全边界，因此跨模块实例可识别比不可伪造重要。
 * 今天还没有宿主装 `entry.react`，先把两个品牌定成同一种形状，免得 react 入口接线时重演一遍。
 */
const reactPluginBrand: unique symbol = Symbol.for('web-agent.react-plugin')

export type ReactPluginDisposer = () => void

export interface ReactPluginInstallApi {
  registerRenderer<K extends TimelineItemKind>(
    kind: K,
    renderer: TimelineRenderer<K>,
  ): void
}

export interface ReactPluginDefinition {
  install(api: ReactPluginInstallApi): void | ReactPluginDisposer
}

/** 由 defineReactPlugin 加上运行时品牌的 UI 插件。 */
export interface ReactPlugin extends ReactPluginDefinition {
  readonly [reactPluginBrand]: true
}

/** 创建不可伪装的 React UI 插件定义。 */
export function defineReactPlugin(definition: ReactPluginDefinition): ReactPlugin {
  return Object.freeze({ ...definition, [reactPluginBrand]: true as const })
}

/** 判断值是否由 defineReactPlugin 创建。 */
export function isReactPlugin(value: unknown): value is ReactPlugin {
  return typeof value === 'object'
    && value !== null
    && (value as ReactPlugin)[reactPluginBrand] === true
}
