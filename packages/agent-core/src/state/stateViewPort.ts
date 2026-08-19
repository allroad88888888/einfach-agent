import { executionGraphAtom } from '../execution/graph'
import type { Store } from '@einfach/core'
import { prepareSubagentSkillGovernance, type SkillGovernanceAction, type SkillGovernanceOperation } from '../runtime/skillGovernance'
import type {
  ReadWorkspaceFileInput,
  ReadWorkspaceFileResult,
  ReadWorkspaceRunIndexPageInput,
  ReadWorkspaceRunIndexPageResult,
  WorkspaceRuntimeResult,
} from '../runtime/workspaceRead'
import { itemsAtom } from './sessionAtoms'

// workspaceRead 只做【调用时动态 import】，不能静态 import（同 persistenceBridge → hydrate 的处置）：
// 本文件的值导出被 `subagents` barrel 再导出，而 barrel 又挂在 tools/agents → registerStandardTools
// → `apps/web/src/test/setup.ts` 这条链上。静态边会在各测试文件的 vi.mock 生效前，把
// workspaceRead 连同它顶层 import 的真 hostBridge 一起灌进 worker 模块图，
// 令 workspaceRead 系 mock 全部失效（setup.ts 里记的同款回归，S2b 又踩了一次）。
// 端口只需要在调用时刻拿到实现，推迟加载即可；两个函数本来就是 async，不引入新的时序语义。
// promise 必须缓存：同一 tick 里并发首次 import 同一模块时，Vitest 的 mocker 会有一路拿到未被
// 替换的真模块（实测 SubagentTreePanel 的 run 索引与 candidate skills 两条 effect 同时触发时命中），
// 缓存后每个模块实例只发一次 import，解析结果对所有调用点一致。
let workspaceReadModule: Promise<typeof import('../runtime/workspaceRead')> | undefined
const loadWorkspaceRead = () => (workspaceReadModule ??= import('../runtime/workspaceRead'))

async function readWorkspaceFile(
  input: ReadWorkspaceFileInput,
): Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>> {
  return (await loadWorkspaceRead()).readWorkspaceFile(input)
}

async function readWorkspaceRunIndexPage(
  input: ReadWorkspaceRunIndexPageInput,
): Promise<WorkspaceRuntimeResult<ReadWorkspaceRunIndexPageResult>> {
  return (await loadWorkspaceRead()).readWorkspaceRunIndexPage(input)
}

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
