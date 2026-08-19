// 生命周期探针的 React UI 插件；仅在宿主明确开放 reasoning renderer 时安装。

import { defineReactPlugin, type ReactPlugin } from '@einfach-agent/react-plugin'
import { LifecycleProbeReasoningRenderer } from './lifecycleProbeReasoningRenderer'

/** 创建与 Core 生命周期探针配对的 React UI 插件。 */
export function createLifecycleProbeReactPlugin(): ReactPlugin {
  return defineReactPlugin({
    install(api) {
      api.registerRenderer('reasoning', LifecycleProbeReasoningRenderer)
    },
  })
}
