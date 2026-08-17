// Runtime command facade: the only mutation surface consumed by UI code.
// Each command is bound to a CoreInstance; the default exports below bind defaultCore.

import { defaultCore, type CoreInstance, type RuntimeConfig } from './core/coreInstance'
import { createCardCommands } from './commands/cardCommands'
import { createPlanCommands } from './commands/planCommands'
import { createProjectSkillsCommands } from './commands/projectSkillsCommands'
import { createRecoveryCommands } from './commands/recoveryCommands'
import { createRunCommands } from './commands/runCommands'
import { createRunLifecycleCommands } from './commands/runLifecycleCommands'
import { createSessionCommands, DEFAULT_SESSION_TITLE, deriveSessionTitle } from './commands/sessionCommands'
import { createSessionScopeCommands } from './commands/sessionScopeCommands'
import { createSubagentViewCommands } from './commands/subagentViewCommands'
import { createWorkspaceCommands } from './commands/workspaceCommands'
import { createPluginCommandFacade } from './core/pluginCommandFacade'

export { DEFAULT_SESSION_TITLE, deriveSessionTitle } from './commands/sessionCommands'
export type { RuntimeConfig } from './core/coreInstance'
export type {
  PreparedUserInput,
  PreparedUserInputRollbackReason,
  SendMessageInput,
  SendMessageResult,
  UserInputImage,
  UserInputPreparationContext,
  UserInputPreparer,
  UserInputSubmission,
} from './userInputPreparation'
export type {
  UserContentDisposer,
  UserContentDisposalContext,
  UserContentDisposalReason,
} from './userContentDisposal'
export type { ContinueRecoveredSessionResult, SessionRecoveryStatus } from './commands/recoveryCommands'

/** Updates runtime configuration for the default command instance. */
export function configureCommands(config: Partial<RuntimeConfig>): void {
  Object.assign(defaultCore.config, config)
}

/** Builds the complete command surface bound to a single runtime core. */
export function createCommands(core: CoreInstance = defaultCore) {
  const workspace = createWorkspaceCommands(core)
  const session = createSessionCommands(core)
  const sessionScope = createSessionScopeCommands(core)
  const runLifecycle = createRunLifecycleCommands(core, {
    renameSession: session.renameSession,
    defaultSessionTitle: DEFAULT_SESSION_TITLE,
    deriveSessionTitle,
  })
  const recovery = createRecoveryCommands(core)
  const pausedRun = createRunCommands(core)
  const plan = createPlanCommands(core, runLifecycle.stopRun)
  const cards = createCardCommands(core)
  const projectSkills = createProjectSkillsCommands(core)
  const subagentView = createSubagentViewCommands(core)
  return {
    ...workspace,
    ...session,
    ...sessionScope,
    ...runLifecycle,
    ...recovery,
    ...pausedRun,
    ...plan,
    ...cards,
    ...projectSkills,
    ...subagentView,
  }
}

export type CommandApi = ReturnType<typeof createCommands>

const defaultCommands = createCommands()
defaultCore.plugins.bindCommandFacade(createPluginCommandFacade(defaultCommands))

export const {
  newWorkspace,
  selectWorkspace,
  toggleWorkspaceExpanded,
  toggleWorkspaceSettings,
  renameWorkspace,
  renameSession,
  newSession,
  selectSession,
  removeSession,
  sessionAtomScope,
  setWorkspaceRoot,
  setApprovalMode,
  sendMessage,
  continueInterruptedRun,
  getSessionRecoveryStatus,
  listSessionRecoveryStatuses,
  continueRecoveredSession,
  continuePlan,
  stopRun,
  resumeWithAnswers,
  confirmTool,
  approvePlan,
  rollbackPlanStage,
  answerQuestion,
  discardArtifact,
  refreshProjectSkills,
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
} = defaultCommands
