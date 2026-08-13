import { registerSubagentViewCommandFacade } from '@web-agent/core/subagents'
import {
  loadSubagentArchiveAtom,
  loadSubagentArchivePreviewAtom,
  loadSubagentTraceAtom,
  loadGlobalSubagentRunsAtom,
  selectedGlobalSubagentRunAtom,
  selectedSubagentNodeKeyAtom,
} from './subagentViewAtoms'
import {
  candidateSkillFilterAtom,
  closeSkillGovernanceDialogAtom,
  confirmSkillGovernanceAtom,
  loadCandidateSkillsAtom,
  openSkillGovernanceDialogAtom,
  selectedCandidateSkillIdAtom,
  type CandidateSkill,
} from './subagentSkillGovernanceAtoms'

registerSubagentViewCommandFacade({
  selectSubagentNode: (store, key) => store.setter(selectedSubagentNodeKeyAtom, key),
  selectGlobalSubagentRun: (store, selection) => store.setter(selectedGlobalSubagentRunAtom, selection),
  loadGlobalSubagentRuns: (store, input) => store.setter(loadGlobalSubagentRunsAtom, input),
  loadSubagentArchive: (store, input) => store.setter(loadSubagentArchiveAtom, input),
  loadSubagentArchivePreview: (store, input) => store.setter(loadSubagentArchivePreviewAtom, input),
  loadSubagentTrace: (store, input) => store.setter(loadSubagentTraceAtom, input),
  setCandidateSkillFilter: (store, value) => store.setter(candidateSkillFilterAtom, value),
  selectCandidateSkill: (store, skillId) => store.setter(selectedCandidateSkillIdAtom, skillId),
  loadCandidateSkills: (store, input) => store.setter(loadCandidateSkillsAtom, input),
  // port 对 core 保持 scoreParts 不透明（unknown[]）；真实类型归本包，边界处收窄。
  openSkillGovernanceDialog: (store, input) =>
    store.setter(openSkillGovernanceDialogAtom, { ...input, candidate: input.candidate as CandidateSkill }),
  closeSkillGovernanceDialog: (store) => store.setter(closeSkillGovernanceDialogAtom),
  confirmSkillGovernance: (store) => store.setter(confirmSkillGovernanceAtom),
})
