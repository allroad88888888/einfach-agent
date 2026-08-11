// 「起进程确认」的 UI 状态（H2）。
//
// 单独成文件而不是塞进 state.ts：那里是 MCP 设置的通用视图状态，这里是一道安全门的
// 待办队列——它的生命周期跟着 service 实例走（换一个 service 就该清空），语义与其余
// atom 不同。UI 照旧只读 atom、只调 commands.ts 的命令。

import { atom } from '@einfach/react'
import type { Store } from '@einfach/core'
import { mcpServerConfigsAtom } from './state'
import { mayLaunchMcpServer } from './stdioLaunchConsent'

/** 这次确认是被什么动作触发的，决定提示里怎么描述后果。 */
export type McpLaunchConsentReason =
  /** 刚添加或导入这个服务，接下来要探测它的工具清单。 */
  | 'install'
  /** 用户点了「重连」。 */
  | 'connect'
  /** 用户打开了「自动连接」。 */
  | 'auto-connect'

/** 摆给用户看的一次确认请求；只放展示需要的字段，不放任何回调。 */
export interface McpLaunchConsentRequest {
  readonly id: string
  readonly name: string
  /** 将执行的完整命令行。 */
  readonly commandLine: string
  readonly cwd?: string
  readonly reason: McpLaunchConsentReason
  /** 确认后是否会变成「每次启动都自动执行」。 */
  readonly autoConnect: boolean
}

/** 按 serverId 索引：一个服务同时只会有一个待确认请求。 */
export const mcpPendingLaunchConsentsAtom =
  atom<Readonly<Record<string, McpLaunchConsentRequest>>>({})
mcpPendingLaunchConsentsAtom.debugLabel = 'mcpPendingLaunchConsents'

/** 命令行尚未确认（或确认已被命令改动作废）的 stdio 服务，卡片据此换文案。 */
export const mcpUnconfirmedLaunchIdsAtom = atom<ReadonlySet<string>>((get) => new Set(
  get(mcpServerConfigsAtom)
    .filter((config) => !mayLaunchMcpServer(config))
    .map((config) => config.id),
))
mcpUnconfirmedLaunchIdsAtom.debugLabel = 'mcpUnconfirmedLaunchIds'

export function resetMcpLaunchConsentState(store: Store): void {
  store.setter(mcpPendingLaunchConsentsAtom, {})
}
