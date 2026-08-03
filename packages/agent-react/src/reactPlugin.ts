// React UI 插件的公开契约；只交给插件精确 renderer 注册能力。

import type {
  TimelineItemKind,
  TimelineRenderer,
} from './timelineRendererTypes'

const reactPluginBrand = Symbol('web-agent.react-plugin')

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
