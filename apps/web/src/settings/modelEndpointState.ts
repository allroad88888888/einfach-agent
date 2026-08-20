// openai-compat 接入点登记在界面上的那点状态
// ---------------------------------------------------------------------------
// 住**界面 store**（`apps/web/src/uiStore.ts`），不是 core 的任何一个 store：它是「用户正在
// 设置面板里编辑的东西」，刷新即丢，真相在 `~/.webAgent/config.json` 里（CLAUDE.md 的判据是
// 「这份内容除了它自己还活在哪里」）。draft 是没保存的输入，`baseUrl` 是后端确认过的那条。
//
// 与凭据那份状态形状相似但**只有一条**，因此不需要按 id 分桶：接入点全局只有一个
// （openai-compat 只有 default 一个作用域，理由见 host-node 的 provider.ts）。

import type { Store } from '@einfach/core'
import { atom } from '@einfach/react'
import { MAX_MODEL_ENDPOINT_LENGTH } from './modelEndpointHost'

export type ModelEndpointFieldState =
  | { status: 'idle' | 'loading' | 'ready' | 'saved'; configured: boolean; baseUrl?: string }
  | { status: 'error'; error: string; configured: boolean; baseUrl?: string }

export interface ModelEndpointEntry {
  draft: string
  state: ModelEndpointFieldState
}

const EMPTY_STATE: ModelEndpointFieldState = { status: 'idle', configured: false }

function createInitialEntry(): ModelEndpointEntry {
  return { draft: '', state: { ...EMPTY_STATE } }
}

export const modelEndpointEntryAtom = atom<ModelEndpointEntry>(createInitialEntry())
modelEndpointEntryAtom.debugLabel = 'modelEndpointEntry'

export const modelEndpointHostAvailableAtom = atom(false)
modelEndpointHostAvailableAtom.debugLabel = 'modelEndpointHostAvailable'

export function setModelEndpointDraft(store: Store, draft: string): void {
  const entry = store.getter(modelEndpointEntryAtom)
  store.setter(modelEndpointEntryAtom, {
    ...entry,
    draft: draft.slice(0, MAX_MODEL_ENDPOINT_LENGTH),
  })
}

/**
 * 写状态时**不动 draft**：保存失败后用户敲进去的地址必须还在框里，否则他要重新打一遍才能
 * 改掉那个填错的字母。清空 draft 是保存成功这条路上的显式动作（见 modelEndpointCommands.ts）。
 */
export function setModelEndpointState(store: Store, state: ModelEndpointFieldState): void {
  store.setter(modelEndpointEntryAtom, {
    ...store.getter(modelEndpointEntryAtom),
    state,
  })
}

export function resetModelEndpointState(store: Store): void {
  store.setter(modelEndpointEntryAtom, createInitialEntry())
}
