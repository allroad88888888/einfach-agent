import { activeSessionIdAtom } from '../../state/rootStore'
import {
  loadSubagentArchiveAtom,
  loadSubagentArchivePreviewAtom,
  loadSubagentTraceAtom,
  loadGlobalSubagentRunsAtom,
  selectedGlobalSubagentRunAtom,
  selectedSubagentNodeKeyAtom,
} from '../../state/subagentViewAtoms'
import {
  candidateSkillFilterAtom,
  closeSkillGovernanceDialogAtom,
  confirmSkillGovernanceAtom,
  loadCandidateSkillsAtom,
  openSkillGovernanceDialogAtom,
  selectedCandidateSkillIdAtom,
  type CandidateSkill,
} from '../../state/subagentSkillGovernanceAtoms'
import type { CoreInstance } from '../core/coreInstance'
import type { GlobalSubagentRunSelection } from '../../state/subagentViewAtoms'
import type { SkillGovernanceAction } from '../skillGovernance'

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

function activeSessionStore(core: CoreInstance) {
  const id = core.rootStore.getter(activeSessionIdAtom)
  return id ? core.getSessionStore(id).store : undefined
}

/** Builds UI commands for subagent history, selection, and skill-governance state. */
export function createSubagentViewCommands(core: CoreInstance) {
  function selectSubagentNode(key?: string): void {
    activeSessionStore(core)?.setter(selectedSubagentNodeKeyAtom, key)
  }

  function selectGlobalSubagentRun(selection?: GlobalSubagentRunSelection): void {
    activeSessionStore(core)?.setter(selectedGlobalSubagentRunAtom, selection)
  }

  function loadGlobalSubagentRuns(input: GlobalRunsInput): Promise<void> | undefined {
    return activeSessionStore(core)?.setter(loadGlobalSubagentRunsAtom, input)
  }

  function loadSubagentArchive(input: ArchiveInput): Promise<void> | undefined {
    return activeSessionStore(core)?.setter(loadSubagentArchiveAtom, input)
  }

  function loadSubagentArchivePreview(input: PreviewInput): Promise<void> | undefined {
    return activeSessionStore(core)?.setter(loadSubagentArchivePreviewAtom, input)
  }

  function loadSubagentTrace(input: TraceInput): Promise<void> | undefined {
    return activeSessionStore(core)?.setter(loadSubagentTraceAtom, input)
  }

  function setCandidateSkillFilter(value: string): void {
    activeSessionStore(core)?.setter(candidateSkillFilterAtom, value)
  }

  function selectCandidateSkill(skillId?: string): void {
    activeSessionStore(core)?.setter(selectedCandidateSkillIdAtom, skillId)
  }

  function loadCandidateSkills(input: CandidateLoadInput): Promise<void> | undefined {
    return activeSessionStore(core)?.setter(loadCandidateSkillsAtom, input)
  }

  function openSkillGovernanceDialog(input: {
    action: SkillGovernanceAction
    candidate: CandidateSkill
    workspaceRoot?: string
  }): void {
    activeSessionStore(core)?.setter(openSkillGovernanceDialogAtom, input)
  }

  function closeSkillGovernanceDialog(): void {
    activeSessionStore(core)?.setter(closeSkillGovernanceDialogAtom)
  }

  function confirmSkillGovernance(): Promise<void> | undefined {
    return activeSessionStore(core)?.setter(confirmSkillGovernanceAtom)
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
