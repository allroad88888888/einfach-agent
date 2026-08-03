import { activeSessionIdAtom, sessionsAtom, workspacesAtom } from '../../state/rootStore'
import { resolveSessionWorkspaceRoot } from '../../state/workspaceState'
import type { CoreInstance } from '../core/coreInstance'
import { buildProjectSkillsBridge } from '../projectSkillsBridge'

/** Builds commands that refresh project skill discovery for the active workspace. */
export function createProjectSkillsCommands(core: CoreInstance) {
  async function refreshProjectSkills(): Promise<void> {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const meta = core.rootStore.getter(sessionsAtom)[id]
    if (!meta) return
    const workspaceRoot = resolveSessionWorkspaceRoot(meta, core.rootStore.getter(workspacesAtom))
    if (workspaceRoot) await core.projectSkills.refresh(workspaceRoot, buildProjectSkillsBridge())
  }

  return { refreshProjectSkills }
}
