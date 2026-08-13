import { useAtomValue } from '@einfach/react'
import { useEffect } from 'react'
import {
  candidateSkillFilterAtom,
  candidateSkillsAtom,
  filteredCandidateSkillsAtom,
  selectedCandidateSkillIdAtom,
  skillGovernanceDialogAtom,
  type CandidateSkill,
} from '@web-agent/subagents'
import {
  closeSkillGovernanceDialog,
  confirmSkillGovernance,
  loadCandidateSkills,
  openSkillGovernanceDialog,
  selectCandidateSkill,
  setCandidateSkillFilter,
} from '@web-agent/core/runtime/commands'

function CandidateScore({ candidate }: { candidate: CandidateSkill }) {
  return (
    <details className="agentnew-skill-score">
      <summary>评分 {candidate.score}/100</summary>
      <ul>
        {candidate.scoreParts.map((part) => (
          <li key={part.label}><strong>{part.label} {part.points}/{part.maximum}</strong><span>{part.explanation}</span></li>
        ))}
      </ul>
      <small>评分只用于排序和解释，不会自动 promote 或 archive。</small>
    </details>
  )
}

/** Shows candidate-skill review state and forwards its mutations through runtime commands. */
export function SubagentSkillGovernancePanel({ workspaceRoot }: { workspaceRoot?: string }) {
  const state = useAtomValue(candidateSkillsAtom)
  const candidates = useAtomValue(filteredCandidateSkillsAtom)
  const filter = useAtomValue(candidateSkillFilterAtom)
  const selectedId = useAtomValue(selectedCandidateSkillIdAtom)
  const dialog = useAtomValue(skillGovernanceDialogAtom)
  const selected = state.status === 'ready' ? state.candidates.find((item) => item.skillId === selectedId) : undefined

  useEffect(() => {
    closeSkillGovernanceDialog()
    selectCandidateSkill(undefined)
    void loadCandidateSkills({ workspaceRoot })
  }, [workspaceRoot])

  return (
    <section className="agentnew-skill-governance" aria-label="candidate skill 治理">
      <div className="agentnew-subagent-section-label">
        candidate skills
        <button type="button" onClick={() => void loadCandidateSkills({ workspaceRoot, force: true })}>刷新</button>
      </div>
      {state.status === 'loading' || state.status === 'idle' ? <div className="agentnew-subagent-archive-state">正在校验 skills 索引与 frontmatter…</div> : null}
      {state.status === 'empty' ? <div className="agentnew-subagent-archive-state">{state.error}</div> : null}
      {state.status === 'error' ? <div className="agentnew-subagent-archive-state agentnew-subagent-error">candidate 读取失败：{state.error}<button type="button" onClick={() => void loadCandidateSkills({ workspaceRoot, force: true })}>重试</button></div> : null}
      {state.status === 'ready' ? (
        <>
          <input aria-label="筛选 candidate skill" value={filter} placeholder="筛选 skill…" onChange={(event) => setCandidateSkillFilter(event.currentTarget.value)} />
          <div className="agentnew-skill-list">
            {candidates.map((candidate) => (
              <button type="button" key={candidate.skillId} className={selectedId === candidate.skillId ? 'active' : ''} aria-pressed={selectedId === candidate.skillId} onClick={() => selectCandidateSkill(candidate.skillId)}>
                <span><strong>{candidate.skillId}</strong><small>{candidate.kind}</small></span><b>{candidate.score}</b>
              </button>
            ))}
            {candidates.length === 0 ? <small>没有匹配项</small> : null}
          </div>
        </>
      ) : null}
      {selected ? (
        <div className="agentnew-skill-detail">
          <p>{selected.summary}</p>
          <CandidateScore candidate={selected} />
          <div>
            <button type="button" onClick={() => openSkillGovernanceDialog({ action: 'promote', candidate: selected, workspaceRoot })}>请求 Promote</button>
            <button type="button" onClick={() => openSkillGovernanceDialog({ action: 'archive', candidate: selected, workspaceRoot })}>请求 Archive</button>
          </div>
        </div>
      ) : null}
      {dialog.status !== 'closed' ? (
        <div className="agentnew-skill-dialog-backdrop">
          <div role="dialog" aria-modal="true" aria-label="确认 skill 治理操作" className="agentnew-skill-dialog">
            <strong>确认 {dialog.action === 'promote' ? 'Promote' : 'Archive'}</strong>
            <p>目标：<code>{dialog.candidate?.skillId}</code></p>
            <p>{dialog.action === 'promote' ? '该 skill 将进入长期可复用状态。' : '该 skill 将被归档，不再作为 candidate。'}确认后生成待执行 CLI 操作；此界面不会静默修改文件。</p>
            {dialog.status === 'error' ? <p className="agentnew-subagent-error">{dialog.error}</p> : null}
            {dialog.status === 'prepared' ? <div role="status"><p>操作已生成，尚未执行。请在该 workspace 终端运行：</p><code className="agentnew-skill-command">{dialog.operation?.command}</code><p>CLI 将执行完整校验、共享锁、事务 journal 与独立审计。</p></div> : null}
            <div>
              <button type="button" disabled={dialog.status === 'submitting'} onClick={() => closeSkillGovernanceDialog()}>取消/关闭</button>
              {dialog.status === 'confirming' || dialog.status === 'error' ? <button type="button" onClick={() => void confirmSkillGovernance()}>{dialog.status === 'error' ? '重试生成' : '确认生成操作'}</button> : null}
              {dialog.status === 'submitting' ? <button type="button" disabled>正在生成…</button> : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
