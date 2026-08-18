// 每会话的**两个** store 的 Provider 分层（U3 / RUI1 地基）。
// ---------------------------------------------------------------------------
// 从根 rootStore 读当前会话 id（activeSessionIdAtom），把右栏内容包进该会话的两层 store：
//   · einfach 的 `<Provider>` 绑 **UI store**（展开态、滑动窗口、草稿、图片附件）；
//   · `<AgentStoreProvider>` 绑 **agent store**（items/run/plan 等会话状态，core 拥有）。
// 谁当环境 store 是刻意的选择，理由见 packages/agent-react 的 agentStore.tsx 文件头。
//
// key={id} 保证切会话时整体重挂，两个 store 一起换到新会话；两边都按 id 缓存，
// 所以切走再切回来，会话内容和渲染态都还在。无激活会话时渲染空占位。

import type { ReactNode } from 'react'
import { Provider, useAtomValue } from '@einfach/react'
import { AgentStoreProvider } from '@web-agent/react-plugin'
import {
  activeSessionIdAtom,
  activeSessionMetaAtom,
  activeWorkspaceRootAtom,
  sessionAtomScope,
} from '@web-agent/core'
import { getSessionUiStore } from './sessionUiStores'
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
  const agentStore = sessionAtomScope(id)
  const uiStore = getSessionUiStore(id)
  return (
    <Provider store={uiStore} key={id}>
      <AgentStoreProvider store={agentStore}>
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
      </AgentStoreProvider>
    </Provider>
  )
}
