// Runtime command facade: the only mutation surface consumed by UI code.
// Each command is bound to a CoreInstance; the default exports below bind defaultCore.

import { defaultCore, type CoreInstance, type RuntimeConfig } from './core/coreInstance'
import { createCardCommands } from './commands/cardCommands'
import { createCheckpointCommands } from './commands/checkpointCommands'
import { createPlanCommands } from './commands/planCommands'
import { createProjectSkillsCommands } from './commands/projectSkillsCommands'
import { createRunCommands } from './commands/runCommands'
import { createRunLifecycleCommands } from './commands/runLifecycleCommands'
import { createSessionCommands, DEFAULT_SESSION_TITLE, deriveSessionTitle } from './commands/sessionCommands'
import { createSubagentViewCommands } from './commands/subagentViewCommands'
import { createWorkspaceCommands } from './commands/workspaceCommands'
import { createPluginCommandFacade } from './core/pluginCommandFacade'

export { DEFAULT_SESSION_TITLE, deriveSessionTitle } from './commands/sessionCommands'

/** Updates runtime configuration for the default command instance. */
export function configureCommands(config: Partial<RuntimeConfig>): void {
  Object.assign(defaultCore.config, config)
}

/** Builds the complete command surface bound to a single runtime core. */
export function createCommands(core: CoreInstance = defaultCore) {
  const workspace = createWorkspaceCommands(core)
  const session = createSessionCommands(core)
  const runLifecycle = createRunLifecycleCommands(core, {
    renameSession: session.renameSession,
    defaultSessionTitle: DEFAULT_SESSION_TITLE,
    deriveSessionTitle,
  })
  const pausedRun = createRunCommands(core)
  const checkpoint = createCheckpointCommands(core, runLifecycle.stopRun)
  const plan = createPlanCommands(core, runLifecycle.stopRun)
  const cards = createCardCommands(core)
  const projectSkills = createProjectSkillsCommands(core)
  const subagentView = createSubagentViewCommands(core)
  return {
    ...workspace,
    ...session,
    ...runLifecycle,
    ...pausedRun,
    ...checkpoint,
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
  setWorkspaceRoot,
  setApprovalMode,
  sendMessage,
  continueInterruptedRun,
  continuePlan,
  stopRun,
  resumeWithAnswers,
  confirmTool,
  revertToTurn,
  revertTurnToDraft,
  withdrawCurrentTurnToDraft,
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
