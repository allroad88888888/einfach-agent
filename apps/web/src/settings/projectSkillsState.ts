// 项目 Skills 设置面板的瞬态操作状态。
// ---------------------------------------------------------------------------
// 启停偏好本身属于 AppSettings；本文件只表达 UI 是否正在重扫、以及最近一次保存反馈，
// 因而刷新、保存失败都不会污染持久化的工作区选择。

import type { Store } from '@einfach/core'
import { atom } from '@einfach/react'

export type ProjectSkillsPreferenceStatus =
  | { status: 'idle' | 'saved' }
  | { status: 'error'; error: string }

export const projectSkillsRefreshingAtom = atom(false)
projectSkillsRefreshingAtom.debugLabel = 'projectSkillsRefreshing'

export const projectSkillsPreferenceStatusAtom = atom<ProjectSkillsPreferenceStatus>({ status: 'idle' })
projectSkillsPreferenceStatusAtom.debugLabel = 'projectSkillsPreferenceStatus'

export function resetProjectSkillsSettingsState(store: Store): void {
  store.setter(projectSkillsRefreshingAtom, false)
  store.setter(projectSkillsPreferenceStatusAtom, { status: 'idle' })
}
