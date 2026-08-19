# @einfach-agent/plugin-example

Core 与 React UI 配对的外部插件样板。两个入口刻意分离：根入口只提供非 React 的
Core 插件；`/react` 才提供 UI 插件。二者只使用各自包的公开 API，不导入 Core 的 store、atom、
runtime 内部模块。

```ts
import { createCore } from '@einfach-agent/core/plugin'
import { createLifecycleProbePlugin } from '@einfach-agent/plugin-example'

const core = createCore({
  plugins: [createLifecycleProbePlugin({ stopOnRunStart: false })],
})
```

React UI 插件由 React root 的宿主单独安装；它拿不到 `CoreInstance`、command、atom 或 registry
本体，只能注册精确匹配的既有 timeline kind。当前 Web App 会锁定全部内建 kind，因此以下样板适合
宿主明确未锁定 `reasoning` 的场景，不能用于覆盖 App 的内建 renderer。

```tsx
import {
  createTimelineRendererRegistry,
  installReactPlugins,
} from '@einfach-agent/react-plugin'
import { createLifecycleProbeReactPlugin } from '@einfach-agent/plugin-example/react'

const registry = createTimelineRendererRegistry()
const disposeReactPlugin = installReactPlugins(registry, [
  createLifecycleProbeReactPlugin(),
])

// React root 卸载时调用，renderer 注册不会残留。
disposeReactPlugin()
```

样板覆盖四个公共生命周期能力：安装期注册 `lifecycle_probe` 工具、运行期 `observeRun`、受限的 `commands.stopCurrentRun()`，以及 run 卸载 disposer。

测试宿主错误隔离时传入 `throwAfterToolCall: true`；该选项故意从 `onAfterToolCall` 抛出。宿主应记录该插件错误而不破坏主 run。`onRunEvent` 与 `onDispose` 仅用于嵌入方断言样板生命周期。

```ts
createLifecycleProbePlugin({
  onRunEvent: (event) => console.info(event),
  onDispose: () => console.info('plugin run disposed'),
})
```
