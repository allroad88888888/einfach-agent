import { uiStore } from '../uiStore'
// 项目 Skills 设置面板的命令面：工作区级启停偏好与重新扫描。
// ---------------------------------------------------------------------------
// UI 不直接写 atom 或存储；这里先落盘，再把同一偏好发布给 core 的 root store，确保下一次
// skill_manifest、skill_search 与 skill_read 读取的都是用户刚刚选择的集合。

import {
  refreshProjectSkills,
  disabledProjectSkillsByWorkspaceAtom,
  rootStore,
} from '@web-agent/core'
import { setProjectSkillEnabled } from '@web-agent/core/skills'
import { appSettingsAtom } from './state'
import { saveAppSettings } from './commands'
import {
  projectSkillsPreferenceStatusAtom,
  projectSkillsRefreshingAtom,
} from './projectSkillsState'

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return '项目 Skills 设置保存失败'
}

/** Enables or disables one discovered project skill for the selected workspace. */
export function updateProjectSkillEnabled(
  workspaceId: string,
  skillName: string,
  enabled: boolean,
): boolean {
  try {
    const settings = uiStore.getter(appSettingsAtom)
    const disabledProjectSkills = setProjectSkillEnabled(
      settings.agent.disabledProjectSkills,
      workspaceId,
      skillName,
      enabled,
    )
    saveAppSettings({
      ...settings,
      agent: { ...settings.agent, disabledProjectSkills },
    })
    // 发布给 runtime 的是 **core 的 root store** —— 这条偏好要被 skill_manifest / skill_search
    // 读到，不是界面态；面板自己的状态（保存中/刷新中）才在界面 store 里。
    rootStore.setter(disabledProjectSkillsByWorkspaceAtom, disabledProjectSkills)
    uiStore.setter(projectSkillsPreferenceStatusAtom, { status: 'saved' })
    return true
  } catch (error) {
    uiStore.setter(projectSkillsPreferenceStatusAtom, {
      status: 'error',
      error: errorMessage(error),
    })
    return false
  }
}

/** Re-scans the active workspace while exposing a single shared loading state to the panel. */
export async function refreshProjectSkillsFromSettings(): Promise<void> {
  if (uiStore.getter(projectSkillsRefreshingAtom)) return
  uiStore.setter(projectSkillsRefreshingAtom, true)
  try {
    await refreshProjectSkills()
  } catch (error) {
    uiStore.setter(projectSkillsPreferenceStatusAtom, {
      status: 'error',
      error: errorMessage(error),
    })
  } finally {
    uiStore.setter(projectSkillsRefreshingAtom, false)
  }
}
