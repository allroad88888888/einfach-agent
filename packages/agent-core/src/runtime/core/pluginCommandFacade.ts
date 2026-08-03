// 外部插件的受限命令投影。宿主在顶层把当前 Core 已绑定的命令注入这里。

/** 公开插件唯一可调用的运行命令。 */
export interface PluginCommandFacade {
  /**
   * 请求停止当前 Core 的当前 run。
   *
   * true 表示底层命令已被成功委派；false 表示底层命令抛错。它不宣称一定存在可停止的 run。
   */
  stopCurrentRun(): boolean
}

/** 从已绑定当前 Core 的 stopRun 命令创建不可变的最小 facade。 */
export function createPluginCommandFacade(
  commands: { stopRun(): void },
): PluginCommandFacade {
  return Object.freeze({
    stopCurrentRun(): boolean {
      try {
        commands.stopRun()
        return true
      } catch {
        return false
      }
    },
  })
}
