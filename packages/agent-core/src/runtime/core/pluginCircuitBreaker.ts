// 动态安装插件的连续失败熔断（P7）。
// ---------------------------------------------------------------------------
// 只对经 PluginHost.installPlugin 动态安装的插件生效——构造期（createCore({ plugins }) 的
// inputs）插件是宿主源码信任域，成本与必要性都不对等，不经过本文件
// （docs/plugin-and-provider-issues.md P7 卡：选小实现成本这一档，卡内写明）。
//
// 拍板（docs/plugin-and-provider-issues.md「未决（已拍板）」第 5 条）：同一插件连续 3 次 hook
// 失败即自动停用；成功一次即归零；不自动恢复——恢复是调用方重新 installPlugin 的动作。
// 计数用闭包持有，不用跨安装共享的 Map：一次 wrapDynamicPluginActivate 调用 = 一份独立计数
// 生命周期，天然满足「手动重新启用后计数清零」，不需要显式重置 API。
//
// 归因（蓝图第 5 节）：每次 hook 失败与自动停用都经 ctx.traceEvent 带上 plugin.id/plugin.version，
// 供 trace 按插件定位「哪个插件的哪个 hook 在失败」。

import type { CoreCtx } from './coreCtx'
import type { LoopHooks } from './loopHooks'
import type { PluginApi } from './pluginApi'

/** 动态安装插件的最小身份：id 是计数与归因维度，version 只用于归因展示。 */
export interface PluginIdentity {
  readonly id: string
  readonly version: string
}

/** 连续失败达到这个次数即自动停用（拍板值，见文件头）。 */
export const PLUGIN_HOOK_FAILURE_THRESHOLD = 3

type AnyHookFn = (ctx: CoreCtx, ...rest: unknown[]) => unknown

/**
 * 给一个动态插件的 activate 包一层熔断：代理它拿到的 PluginApi，让它注册的每个 hook 都经
 * try/catch 计数——同一插件连续失败达到阈值即调用 onAutoDisable（宿主传入，通常是这次安装的
 * installation.dispose），且发一条「已自动停用」的 trace 事件。任一次成功都把计数归零。
 *
 * 只代理 hook：install 阶段的工具注册、安装期预检与本文件无关，由 pluginHost 的
 * installPlugins 原样处理。
 */
export function wrapDynamicPluginActivate(
  activate: (api: PluginApi) => void | (() => void),
  identity: PluginIdentity,
  onAutoDisable: () => void,
): (api: PluginApi) => void | (() => void) {
  let consecutiveFailures = 0
  let tripped = false

  function wrapHook<K extends keyof LoopHooks>(
    name: K,
    fn: NonNullable<LoopHooks[K]>,
  ): NonNullable<LoopHooks[K]> {
    const raw = fn as unknown as AnyHookFn
    const guarded: AnyHookFn = async (ctx, ...rest) => {
      try {
        const result = await raw(ctx, ...rest)
        consecutiveFailures = 0
        return result
      } catch (error) {
        consecutiveFailures += 1
        const message = error instanceof Error ? error.message : String(error)
        ctx.traceEvent('agent.plugin_hook_failed', {
          'plugin.id': identity.id,
          'plugin.version': identity.version,
          hook: name,
          consecutiveFailures,
          error: message,
        })
        if (!tripped && consecutiveFailures >= PLUGIN_HOOK_FAILURE_THRESHOLD) {
          tripped = true
          ctx.traceEvent('agent.plugin_auto_disabled', {
            'plugin.id': identity.id,
            'plugin.version': identity.version,
            hook: name,
            consecutiveFailures,
            reason: `插件 ${identity.id} 连续 ${PLUGIN_HOOK_FAILURE_THRESHOLD} 次 hook 失败，已自动停用`,
          })
          try {
            onAutoDisable()
          } catch {
            // 停用本身失败不能掩盖原始 hook 错误——下面照样 rethrow 原始 error。
          }
        }
        throw error
      }
    }
    return guarded as unknown as NonNullable<LoopHooks[K]>
  }

  return (api: PluginApi) =>
    activate({
      commands: api.commands,
      registerTool: api.registerTool,
      subscribe: api.subscribe,
      observeRun: api.observeRun,
      hook: (name, fn) => api.hook(name, wrapHook(name, fn)),
    })
}
