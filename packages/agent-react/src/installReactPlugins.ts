// React root 的插件安装器；集中释放 renderer 注册，保证卸载和失败回滚没有残留。

import {
  isReactPlugin,
  type ReactPlugin,
  type ReactPluginDisposer,
} from './reactPlugin'
import type {
  TimelineItemKind,
  TimelineRenderer,
  TimelineRendererRegistry,
} from './timelineRendererTypes'

function disposeAll(disposers: readonly ReactPluginDisposer[]): unknown {
  let firstError: unknown
  for (const dispose of [...disposers].reverse()) {
    try {
      dispose()
    } catch (error) {
      firstError ??= error
    }
  }
  return firstError
}

/**
 * 在一个 React root 的 registry 中安装 UI 插件。
 * 插件仅能注册已知 kind 的 renderer，所有注册均由宿主追踪并在失败或卸载时释放。
 */
export function installReactPlugins(
  registry: TimelineRendererRegistry,
  plugins: readonly ReactPlugin[],
): ReactPluginDisposer {
  const rendererDisposers: ReactPluginDisposer[] = []
  const pluginDisposers: ReactPluginDisposer[] = []

  try {
    for (const plugin of plugins) {
      if (!isReactPlugin(plugin)) {
        throw new Error('React plugins must be created with defineReactPlugin.')
      }
      const pluginDisposer = plugin.install({
        registerRenderer<K extends TimelineItemKind>(
          kind: K,
          renderer: TimelineRenderer<K>,
        ): void {
          rendererDisposers.push(registry.register(kind, renderer))
        },
      })
      if (pluginDisposer) pluginDisposers.push(pluginDisposer)
    }
  } catch (error) {
    disposeAll(pluginDisposers)
    disposeAll(rendererDisposers)
    throw error
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const pluginDisposeError = disposeAll(pluginDisposers)
    const rendererDisposeError = disposeAll(rendererDisposers)
    if (pluginDisposeError) throw pluginDisposeError
    if (rendererDisposeError) throw rendererDisposeError
  }
}
