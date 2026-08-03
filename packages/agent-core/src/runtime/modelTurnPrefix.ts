import { isTauri } from '@tauri-apps/api/core'
import { workspacesAtom } from '../state/rootStore'
import { resolveSessionWorkspaceRoot } from '../state/workspaceState'
import type { SessionMeta } from '../state/core.type'
import type { SystemItem } from '@web-agent/ai'
import { buildSkillManifestText } from '../skills/registry'
import { buildProjectSkillsBridge } from './projectSkillsBridge'
import { detectHostPlatform } from './hostPlatform'
import {
  buildCustomInstructionsItem,
  buildEnvironmentItem,
  buildSystemItem,
  buildToolManifestText,
} from './modelTurn'
import type { CoreInstance } from './core/coreInstance'

export interface StableModelPrefix {
  items: SystemItem[]
  content: string
  system: SystemItem
  environment: SystemItem
  skillManifest: SystemItem
  toolManifest: SystemItem
  customInstructions?: SystemItem
  workspaceRoot?: string
  isTauri: boolean
}

/**
 * Builds the cacheable request prefix for one session.
 *
 * This is intentionally the only assembly point for stable system items: the
 * resulting order is part of the provider prefix-cache contract.
 */
export async function buildStableModelPrefix(
  sessionMeta: SessionMeta,
  core: CoreInstance,
): Promise<StableModelPrefix> {
  const workspaceRoot = resolveSessionWorkspaceRoot(
    sessionMeta,
    core.rootStore.getter(workspacesAtom),
  )
  if (workspaceRoot) {
    await core.projectSkills.ensure(workspaceRoot, buildProjectSkillsBridge())
  }

  const runtimeIsTauri = isTauri()
  const system = buildSystemItem()
  const projectSkills = workspaceRoot ? core.projectSkills.get(workspaceRoot) : undefined
  const skillManifest: SystemItem = {
    role: 'system',
    content: buildSkillManifestText(projectSkills),
  }
  const toolManifest: SystemItem = {
    role: 'system',
    content: buildToolManifestText(runtimeIsTauri, { registry: core.tools }),
  }
  const customInstructions = buildCustomInstructionsItem(core.config.customInstructions)
  const environment = buildEnvironmentItem({
    workspaceRoot,
    isTauri: runtimeIsTauri,
    platform: detectHostPlatform(),
  })
  const items: SystemItem[] = [
    system,
    skillManifest,
    toolManifest,
    ...(customInstructions ? [customInstructions] : []),
    environment,
  ]

  return {
    items,
    content: items.map((item) => item.content).join('\n'),
    system,
    environment,
    skillManifest,
    toolManifest,
    customInstructions,
    workspaceRoot,
    isTauri: runtimeIsTauri,
  }
}
