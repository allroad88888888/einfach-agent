# @web-agent/plugin-example

非 React 的外部插件样板。它只使用 `@web-agent/core/plugin` 的公开 API，不导入 Core 的 store、atom、runtime 内部模块或 React。

```ts
import { createCore } from '@web-agent/core/plugin'
import { createLifecycleProbePlugin } from '@web-agent/plugin-example'

const core = createCore({
  plugins: [createLifecycleProbePlugin({ stopOnRunStart: false })],
})
```

样板覆盖四个公共生命周期能力：安装期注册 `lifecycle_probe` 工具、运行期 `observeRun`、受限的 `commands.stopCurrentRun()`，以及 run 卸载 disposer。

测试宿主错误隔离时传入 `throwAfterToolCall: true`；该选项故意从 `onAfterToolCall` 抛出。宿主应记录该插件错误而不破坏主 run。`onRunEvent` 与 `onDispose` 仅用于嵌入方断言样板生命周期。

```ts
createLifecycleProbePlugin({
  onRunEvent: (event) => console.info(event),
  onDispose: () => console.info('plugin run disposed'),
})
```
