// 右栏的会话作用域（U3 / RUI1 地基）。
// ---------------------------------------------------------------------------
// 从 core 的 root store 读当前会话 id（activeSessionIdAtom），把右栏包进「该会话 agent store」的
// <AgentStoreProvider>；key={id} 保证切会话时整体重挂，会话内组件（读 itemsAtom/runAtom/…）
// 天然拿到新会话的值。无激活会话时渲染空占位。
//
// **这里不再切 einfach 的环境 store**：界面只有一个 store，在 main.tsx 的应用根上绑一次
// （见 apps/web/src/uiStore.ts）。以前这里切环境 store，导致渲染层随手 useAtom 的展开态、
// 消息窗口、图片附件物理上全落进**会话** store 里 —— 治理边界因此只能靠手工表维持。
//
// 换会话时清掉「当前正在输入的东西」：界面 store 不按会话分桶，不清的话在会话 A 打了一半的字
// 会跟着切到会话 B，点发送就发错地方。哪几项、为什么不做成 atom family，见 sessionScopedViewState.ts。

import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { Trans } from '@lingui/react/macro'
import { useStore } from '@einfach/react'
import { AgentStoreProvider, useRootAtomValue } from '@einfach-agent/react-plugin'
import {
  activeSessionIdAtom,
  activeSessionMetaAtom,
  activeWorkspaceRootAtom,
  sessionAtomScope,
  type ModelSettings,
} from '@einfach-agent/core'
import type { KimiRegion } from '@einfach-agent/ai'
import { kimiRegionSetting } from '../../modelInput/kimiRegionSetting'
import { resetSessionScopedViewState } from './sessionScopedViewState'

export interface ActiveSessionConfig {
  id: string
  workspaceRoot?: string
  approvalMode: 'confirm' | 'auto'
  settings: ModelSettings
  vendor: string
  model: string
  region?: KimiRegion
}

const ActiveSessionContext = createContext<ActiveSessionConfig | undefined>(undefined)

/** Reads the complete active-session configuration without creating a UI-owned copy. */
export function useActiveSessionConfig(): ActiveSessionConfig | undefined {
  return useContext(ActiveSessionContext)
}

export function ActiveSessionProvider({
  children,
}: {
  children: ReactNode | ((session: ActiveSessionConfig) => ReactNode)
}) {
  const id = useRootAtomValue(activeSessionIdAtom)
  const meta = useRootAtomValue(activeSessionMetaAtom)
  const workspaceRoot = useRootAtomValue(activeWorkspaceRootAtom)
  const uiStore = useStore()

  useEffect(() => {
    resetSessionScopedViewState(uiStore)
  }, [id, uiStore])

  if (!id) {
    return (
      <div className="agentnew-empty">
        <Trans>还没有会话，点“新建对话”开始</Trans>
      </div>
    )
  }
  const settings = meta?.settings ?? { vendor: '', model: '' }
  const session: ActiveSessionConfig = {
    id,
    workspaceRoot,
    approvalMode: meta?.toolApprovalMode ?? 'confirm',
    settings,
    vendor: settings.vendor,
    model: settings.model,
    region: kimiRegionSetting(settings),
  }
  // 只读通路：命令面只给「该会话的 atom 作用域」，不给 store 的生命周期（建/丢/清）——
  // 那些仍归 newSession / removeSession 命令（盘点 E7）。
  return (
    <ActiveSessionContext.Provider value={session}>
      <AgentStoreProvider store={sessionAtomScope(id)} key={id}>
        {typeof children === 'function' ? children(session) : children}
      </AgentStoreProvider>
    </ActiveSessionContext.Provider>
  )
}
