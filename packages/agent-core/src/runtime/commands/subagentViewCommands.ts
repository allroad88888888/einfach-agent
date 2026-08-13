import { activeSessionIdAtom } from '../../state/rootStore'
import { getSubagentViewCommandFacade, type SkillGovernanceAction } from '../../state/stateViewPort'
import type { CoreInstance } from '../core/coreInstance'

type ArchiveInput = { archiveBasePath: string; workspaceRoot?: string; force?: boolean }
type PreviewInput = {
  archiveBasePath: string
  path: string
  kind: 'result' | 'events'
  workspaceRoot?: string
  content?: string
  nodeKey?: string
}
type TraceInput = { archiveBasePath: string; agentPath: string; nodeKey: string; workspaceRoot?: string; silent?: boolean }
type GlobalRunsInput = { workspaceRoot?: string; force?: boolean; loadMore?: boolean }
type CandidateLoadInput = { workspaceRoot?: string; force?: boolean }
type GlobalSubagentRunSelection = { archiveBasePath: string; workspaceRoot?: string }
type CandidateSkill = { skillId: string; kind: string; summary: string; globalPath: string; score: number; scoreParts: unknown[] }

function activeSessionStore(core: CoreInstance) {
  const id = core.rootStore.getter(activeSessionIdAtom)
  return id ? core.getSessionStore(id).store : undefined
}

/** Builds UI commands for subagent history, selection, and skill-governance state. */
export function createSubagentViewCommands(core: CoreInstance) {
  function selectSubagentNode(key?: string): void {
    const store = activeSessionStore(core)
    if (store) getSubagentViewCommandFacade()?.selectSubagentNode(store, key)
  }

  function selectGlobalSubagentRun(selection?: GlobalSubagentRunSelection): void {
    const store = activeSessionStore(core)
    if (store) getSubagentViewCommandFacade()?.selectGlobalSubagentRun(store, selection)
  }

  function loadGlobalSubagentRuns(input: GlobalRunsInput): Promise<void> | undefined {
    const store = activeSessionStore(core)
    return store ? getSubagentViewCommandFacade()?.loadGlobalSubagentRuns(store, input) : undefined
  }

  function loadSubagentArchive(input: ArchiveInput): Promise<void> | undefined {
    const store = activeSessionStore(core)
    return store ? getSubagentViewCommandFacade()?.loadSubagentArchive(store, input) : undefined
  }

  function loadSubagentArchivePreview(input: PreviewInput): Promise<void> | undefined {
    const store = activeSessionStore(core)
    return store ? getSubagentViewCommandFacade()?.loadSubagentArchivePreview(store, input) : undefined
  }

  function loadSubagentTrace(input: TraceInput): Promise<void> | undefined {
    const store = activeSessionStore(core)
    return store ? getSubagentViewCommandFacade()?.loadSubagentTrace(store, input) : undefined
  }

  function setCandidateSkillFilter(value: string): void {
    const store = activeSessionStore(core)
    if (store) getSubagentViewCommandFacade()?.setCandidateSkillFilter(store, value)
  }

  function selectCandidateSkill(skillId?: string): void {
    const store = activeSessionStore(core)
    if (store) getSubagentViewCommandFacade()?.selectCandidateSkill(store, skillId)
  }

  function loadCandidateSkills(input: CandidateLoadInput): Promise<void> | undefined {
    const store = activeSessionStore(core)
    return store ? getSubagentViewCommandFacade()?.loadCandidateSkills(store, input) : undefined
  }

  function openSkillGovernanceDialog(input: {
    action: SkillGovernanceAction
    candidate: CandidateSkill
    workspaceRoot?: string
  }): void {
    const store = activeSessionStore(core)
    if (store) getSubagentViewCommandFacade()?.openSkillGovernanceDialog(store, input)
  }

  function closeSkillGovernanceDialog(): void {
    const store = activeSessionStore(core)
    if (store) getSubagentViewCommandFacade()?.closeSkillGovernanceDialog(store)
  }

  function confirmSkillGovernance(): Promise<void> | undefined {
    const store = activeSessionStore(core)
    return store ? getSubagentViewCommandFacade()?.confirmSkillGovernance(store) : undefined
  }

  return {
    selectSubagentNode,
    selectGlobalSubagentRun,
    loadGlobalSubagentRuns,
    loadSubagentArchive,
    loadSubagentArchivePreview,
    loadSubagentTrace,
    setCandidateSkillFilter,
    selectCandidateSkill,
    loadCandidateSkills,
    openSkillGovernanceDialog,
    closeSkillGovernanceDialog,
    confirmSkillGovernance,
  }
}
