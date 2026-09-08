import { disabledProjectSkillsByWorkspaceAtom, sessionsAtom, workspacesAtom } from '../state/rootAtoms'
import {
  isSessionCapabilityAllowed,
  sessionCapabilityPolicyVersion,
  SESSION_CAPABILITY_CONTROL_TOOLS,
  type SessionCapabilityKind,
  type SessionCapabilityPolicy,
} from '../state/sessionCapabilityPolicy'
import { filterProjectSkillsSnapshot } from '../skills/projectSkillPreferences'
import { resolveSessionWorkspaceRoot, sessionDisabledProjectSkills } from '../state/workspaceState'
import { hasHostBridge } from './hostBridge'
import { availableToolSummaries } from './turnToolVisibility'
import type { CoreInstance } from './core/coreInstance'
import { compareStableText } from './shared/stableTextOrder'

export interface SessionCapabilityCatalogItem {
  name: string
  label: string
  description: string
  kind: SessionCapabilityKind
  available: boolean
  selected: boolean
}

export interface SessionCapabilityCatalog {
  sessionId: string
  state: 'draft' | 'locked' | 'legacy-unrestricted'
  policyVersion: string
  tools: SessionCapabilityCatalogItem[]
  skills: SessionCapabilityCatalogItem[]
}

function currentItem(
  policy: SessionCapabilityPolicy | undefined,
  kind: SessionCapabilityKind,
  name: string,
  description: string,
): SessionCapabilityCatalogItem {
  return {
    name,
    label: name,
    description,
    kind,
    available: true,
    selected: isSessionCapabilityAllowed(policy, kind, name),
  }
}

function appendMissingLockedItems(
  items: SessionCapabilityCatalogItem[],
  kind: SessionCapabilityKind,
  allowedNames: readonly string[],
): void {
  const current = new Set(items.map((item) => item.name))
  for (const name of allowedNames) {
    if (current.has(name)) continue
    items.push({
      name,
      label: name,
      description: '',
      kind,
      available: false,
      selected: true,
    })
  }
}

function stableItems(items: SessionCapabilityCatalogItem[]): SessionCapabilityCatalogItem[] {
  return items.sort((left, right) => compareStableText(left.name, right.name))
}

/** Resolves the current host/workspace safety ceiling and projects one session's selection. */
export async function resolveSessionCapabilityCatalog(
  core: CoreInstance,
  sessionId: string,
): Promise<SessionCapabilityCatalog | undefined> {
  const session = core.rootStore.getter(sessionsAtom)[sessionId]
  if (!session) return undefined
  const policy = session.capabilityPolicy
  const tools = availableToolSummaries(hasHostBridge(), { registry: core.tools })
    .filter((tool) => !SESSION_CAPABILITY_CONTROL_TOOLS.has(tool.name))
    .map((tool) => currentItem(policy, 'tool', tool.name, tool.description))

  const workspaceRoot = resolveSessionWorkspaceRoot(
    session,
    core.rootStore.getter(workspacesAtom),
  )
  const scanned = workspaceRoot ? await core.projectSkills.ensure(workspaceRoot) : undefined
  const projectSkills = filterProjectSkillsSnapshot(
    scanned,
    sessionDisabledProjectSkills(
      session,
      core.rootStore.getter(disabledProjectSkillsByWorkspaceAtom),
    ),
  )
  const skillsByName = new Map<string, { name: string; description: string }>()
  for (const skill of core.skillRegistry.list()) skillsByName.set(skill.name, skill)
  for (const skill of projectSkills?.entries ?? []) {
    if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill)
  }
  const skills = [...skillsByName.values()]
    .map((skill) => currentItem(policy, 'skill', skill.name, skill.description))

  if (policy?.state === 'locked') {
    appendMissingLockedItems(tools, 'tool', policy.allowedTools)
    appendMissingLockedItems(skills, 'skill', policy.allowedSkills)
  }
  return {
    sessionId,
    state: policy?.state ?? 'legacy-unrestricted',
    policyVersion: sessionCapabilityPolicyVersion(policy),
    tools: stableItems(tools),
    skills: stableItems(skills),
  }
}
