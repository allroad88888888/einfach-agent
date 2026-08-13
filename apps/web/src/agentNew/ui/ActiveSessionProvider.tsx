// 每会话 store 的 Provider 分层（U3 / RUI1 地基）。
// ---------------------------------------------------------------------------
// 从根 rootStore 读当前会话 id（activeSessionIdAtom），把右栏内容包进
// 「该会话独立 store」的 <Provider>；key={id} 保证切会话时整体重挂到新 store，
// 会话内组件（读 itemsAtom/runAtom/checkpointsAtom）天然拿到新会话的值。
// 无激活会话时渲染空占位。

import type { ReactNode } from 'react'
import { Provider, useAtomValue } from '@einfach/react'
import {
  activeSessionIdAtom,
  activeSessionMetaAtom,
  activeWorkspaceRootAtom,
} from '@web-agent/core/state/rootStore'
import { sessionAtomScope } from '@web-agent/core/runtime/commands'
import type { KimiRegion } from '@web-agent/ai'
import { kimiRegionSetting } from '../../modelInput/kimiRegionSetting'

export interface ActiveSessionConfig {
  id: string
  workspaceRoot?: string
  approvalMode: 'confirm' | 'auto'
  vendor: string
  model: string
  region?: KimiRegion
}

export function ActiveSessionProvider({
  children,
}: {
  children: ReactNode | ((session: ActiveSessionConfig) => ReactNode)
}) {
  const id = useAtomValue(activeSessionIdAtom) // 从根 rootStore 读当前会话 id
  const meta = useAtomValue(activeSessionMetaAtom)
  const workspaceRoot = useAtomValue(activeWorkspaceRootAtom)
  if (!id) {
    return <div className="agentnew-empty">还没有会话，点“新建对话”开始</div>
  }
  // 只读通路：命令面只给「该会话的 atom 作用域」，不给 store 的生命周期（建/丢/清）——
  // 那些仍归 newSession / removeSession 命令（盘点 E7）。
  const store = sessionAtomScope(id)
  return (
    <Provider store={store} key={id}>
      {typeof children === 'function'
        ? children({
            id,
            workspaceRoot,
            approvalMode: meta?.toolApprovalMode ?? 'confirm',
            vendor: meta?.settings.vendor ?? '',
            model: meta?.settings.model ?? '',
            region: kimiRegionSetting(meta?.settings),
          })
        : children}
    </Provider>
  )
}
