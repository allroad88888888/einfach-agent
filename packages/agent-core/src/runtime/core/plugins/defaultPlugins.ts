// 默认 loop 插件集合；由 Core 的 pluginHost 在 run 激活时延迟加载。
import { finishReasonPlugin } from './finishReasonPlugin'
import { loopGuardPlugin } from './loopGuardPlugin'
import { migrationPlugin } from './migrationPlugin'
import type { CorePlugin } from '../pluginHost'

export const defaultCorePlugins: readonly CorePlugin[] = [
  { activate: migrationPlugin },
  { activate: loopGuardPlugin },
  { activate: finishReasonPlugin },
]
