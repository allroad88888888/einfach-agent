import { executionGraphAtom } from '../execution/graph'
import type { Store } from '@einfach/core'
import { prepareSubagentSkillGovernance, type SkillGovernanceAction, type SkillGovernanceOperation } from '../runtime/skillGovernance'
import {
  readWorkspaceFile,
  readWorkspaceRunIndexPage,
  type ReadWorkspaceFileInput,
  type ReadWorkspaceFileResult,
  type ReadWorkspaceRunIndexPageInput,
  type ReadWorkspaceRunIndexPageResult,
  type WorkspaceRuntimeResult,
} from '../runtime/workspaceRead'
import { itemsAtom } from './sessionAtoms'

/** Public consumer-side dependencies for the subagent state package. */
export const subagentStatePort = {
  itemsAtom,
  executionGraphAtom,
  readWorkspaceFile,
  readWorkspaceRunIndexPage,
  prepareSkillGovernance: prepareSubagentSkillGovernance,
}

export interface SubagentViewCommandFacade {
  selectSubagentNode(store: Store, key?: string): void
  selectGlobalSubagentRun(store: Store, selection?: { archiveBasePath: string; workspaceRoot?: string }): void
  loadGlobalSubagentRuns(store: Store, input: { workspaceRoot?: string; force?: boolean; loadMore?: boolean }): Promise<void>
  loadSubagentArchive(store: Store, input: { archiveBasePath: string; workspaceRoot?: string; force?: boolean }): Promise<void>
  loadSubagentArchivePreview(store: Store, input: {
    archiveBasePath: string
    path: string
    kind: 'result' | 'events'
    workspaceRoot?: string
    content?: string
    nodeKey?: string
  }): Promise<void>
  loadSubagentTrace(store: Store, input: {
    archiveBasePath: string
    agentPath: string
    nodeKey: string
    workspaceRoot?: string
    silent?: boolean
  }): Promise<void>
  setCandidateSkillFilter(store: Store, value: string): void
  selectCandidateSkill(store: Store, skillId?: string): void
  loadCandidateSkills(store: Store, input: { workspaceRoot?: string; force?: boolean }): Promise<void>
  openSkillGovernanceDialog(store: Store, input: {
    action: SkillGovernanceAction
    candidate: { skillId: string; kind: string; summary: string; globalPath: string; score: number; scoreParts: unknown[] }
    workspaceRoot?: string
  }): void
  closeSkillGovernanceDialog(store: Store): void
  confirmSkillGovernance(store: Store): Promise<void>
}

let subagentViewCommandFacade: SubagentViewCommandFacade | undefined

/** Registers the singleton atom facade owned by the subagent state package. */
export function registerSubagentViewCommandFacade(facade: SubagentViewCommandFacade): void {
  if (subagentViewCommandFacade && subagentViewCommandFacade !== facade) {
    throw new Error('subagent view command facade is already registered')
  }
  subagentViewCommandFacade = facade
}

export function getSubagentViewCommandFacade(): SubagentViewCommandFacade | undefined {
  return subagentViewCommandFacade
}

export type {
  ReadWorkspaceFileInput,
  ReadWorkspaceFileResult,
  ReadWorkspaceRunIndexPageInput,
  ReadWorkspaceRunIndexPageResult,
  SkillGovernanceAction,
  SkillGovernanceOperation,
  WorkspaceRuntimeResult,
}
