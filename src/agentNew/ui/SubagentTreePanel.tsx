import { useAtomValue, useSetAtom } from '@einfach/react'
import { useEffect, type CSSProperties } from 'react'
import {
  archiveSubagentTreesAtom,
  globalSubagentRunsAtom,
  loadGlobalSubagentRunsAtom,
  loadSubagentArchiveAtom,
  loadSubagentArchivePreviewAtom,
  resolveSubagentArchivePath,
  selectedSubagentNodeAtom,
  selectedSubagentNodeKeyAtom,
  selectedGlobalSubagentRunAtom,
  subagentArchiveLoadsAtom,
  subagentArchivePreviewAtom,
  subagentTreesAtom,
  type SubagentTreeView,
  type SubagentTreeViewNode,
} from '@web-agent/core/state/subagentViewAtoms'
import {
  candidateSkillFilterAtom,
  candidateSkillsAtom,
  closeSkillGovernanceDialogAtom,
  confirmSkillGovernanceAtom,
  filteredCandidateSkillsAtom,
  loadCandidateSkillsAtom,
  openSkillGovernanceDialogAtom,
  selectedCandidateSkillIdAtom,
  skillGovernanceDialogAtom,
  type CandidateSkill,
} from '@web-agent/core/state/subagentSkillGovernanceAtoms'

const STATUS_LABEL: Record<SubagentTreeViewNode['status'], string> = {
  queued: '排队',
  distilling: '提炼',
  running: '运行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
}

function StatusBadge({ status }: { status: SubagentTreeViewNode['status'] }) {
  return (
    <span className={`agentnew-subagent-status agentnew-subagent-status--${status}`}>
      {STATUS_LABEL[status]}
    </span>
  )
}

function TreeView({
  tree,
  selectedKey,
  onSelect,
}: {
  tree: SubagentTreeView
  selectedKey?: string
  onSelect: (key: string) => void
}) {
  return (
    <div className="agentnew-subagent-tree" data-status={tree.status}>
      <div className="agentnew-subagent-tree-id">
        {tree.source === 'archive' ? '完整树' : <>批次 <code>{tree.callId}</code> ·</>} tree{' '}
        <code>{tree.treeId}</code>
      </div>
      {tree.nodes.map((node) => (
        <button
          className={`agentnew-subagent-node${selectedKey === node.key ? ' active' : ''}`}
          key={node.key}
          type="button"
          aria-label={`${node.objective} ${STATUS_LABEL[node.status]}`}
          style={{ '--agentnew-tree-depth': node.depth } as CSSProperties}
          aria-pressed={selectedKey === node.key}
          onClick={() => onSelect(node.key)}
        >
          <span className="agentnew-subagent-branch" aria-hidden="true">
            {node.depth === 0 ? '◆' : '└'}
          </span>
          <span className="agentnew-subagent-objective">{node.objective}</span>
          <StatusBadge status={node.status} />
        </button>
      ))}
      {tree.warnings?.map((warning) => (
        <div className="agentnew-subagent-archive-warning" key={warning}>{warning}</div>
      ))}
    </div>
  )
}

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

function SkillGovernancePanel({ workspaceRoot }: { workspaceRoot?: string }) {
  const state = useAtomValue(candidateSkillsAtom)
  const candidates = useAtomValue(filteredCandidateSkillsAtom)
  const filter = useAtomValue(candidateSkillFilterAtom)
  const selectedId = useAtomValue(selectedCandidateSkillIdAtom)
  const dialog = useAtomValue(skillGovernanceDialogAtom)
  const setFilter = useSetAtom(candidateSkillFilterAtom)
  const select = useSetAtom(selectedCandidateSkillIdAtom)
  const load = useSetAtom(loadCandidateSkillsAtom)
  const openDialog = useSetAtom(openSkillGovernanceDialogAtom)
  const closeDialog = useSetAtom(closeSkillGovernanceDialogAtom)
  const confirm = useSetAtom(confirmSkillGovernanceAtom)
  const selected = state.status === 'ready' ? state.candidates.find((item) => item.skillId === selectedId) : undefined

  useEffect(() => {
    closeDialog()
    select(undefined)
    void load({ workspaceRoot })
  }, [workspaceRoot, load, closeDialog, select])

  return (
    <section className="agentnew-skill-governance" aria-label="candidate skill 治理">
      <div className="agentnew-subagent-section-label">
        candidate skills
        <button type="button" onClick={() => void load({ workspaceRoot, force: true })}>刷新</button>
      </div>
      {state.status === 'loading' || state.status === 'idle' ? <div className="agentnew-subagent-archive-state">正在校验 skills 索引与 frontmatter…</div> : null}
      {state.status === 'empty' ? <div className="agentnew-subagent-archive-state">{state.error}</div> : null}
      {state.status === 'error' ? <div className="agentnew-subagent-archive-state agentnew-subagent-error">candidate 读取失败：{state.error}<button type="button" onClick={() => void load({ workspaceRoot, force: true })}>重试</button></div> : null}
      {state.status === 'ready' ? (
        <>
          <input aria-label="筛选 candidate skill" value={filter} placeholder="筛选 skill…" onChange={(event) => setFilter(event.currentTarget.value)} />
          <div className="agentnew-skill-list">
            {candidates.map((candidate) => (
              <button type="button" key={candidate.skillId} className={selectedId === candidate.skillId ? 'active' : ''} aria-pressed={selectedId === candidate.skillId} onClick={() => select(candidate.skillId)}>
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
            <button type="button" onClick={() => openDialog({ action: 'promote', candidate: selected, workspaceRoot })}>请求 Promote</button>
            <button type="button" onClick={() => openDialog({ action: 'archive', candidate: selected, workspaceRoot })}>请求 Archive</button>
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
              <button type="button" disabled={dialog.status === 'submitting'} onClick={() => closeDialog()}>取消/关闭</button>
              {dialog.status === 'confirming' || dialog.status === 'error' ? <button type="button" onClick={() => void confirm()}>{dialog.status === 'error' ? '重试生成' : '确认生成操作'}</button> : null}
              {dialog.status === 'submitting' ? <button type="button" disabled>正在生成…</button> : null}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

export function SubagentTreePanel({ workspaceRoot }: { workspaceRoot?: string }) {
  const liveTrees = useAtomValue(subagentTreesAtom)
  const globalRuns = useAtomValue(globalSubagentRunsAtom)
  const globalSelection = useAtomValue(selectedGlobalSubagentRunAtom)
  const archiveTrees = useAtomValue(archiveSubagentTreesAtom)
  const archiveLoads = useAtomValue(subagentArchiveLoadsAtom)
  const preview = useAtomValue(subagentArchivePreviewAtom)
  const selected = useAtomValue(selectedSubagentNodeAtom)
  const selectNode = useSetAtom(selectedSubagentNodeKeyAtom)
  const selectGlobalRun = useSetAtom(selectedGlobalSubagentRunAtom)
  const loadGlobalRuns = useSetAtom(loadGlobalSubagentRunsAtom)
  const loadArchive = useSetAtom(loadSubagentArchiveAtom)
  const loadPreview = useSetAtom(loadSubagentArchivePreviewAtom)
  const selectedGlobalRun = globalRuns.status === 'ready' && globalSelection &&
    globalRuns.workspaceRoot === workspaceRoot &&
    globalSelection.workspaceRoot === workspaceRoot
    ? globalRuns.runs.find((run) => run.archiveBasePath === globalSelection.archiveBasePath)
    : undefined
  const archiveBasePaths = [...new Set([
    ...liveTrees.flatMap((tree) => tree.archiveBasePath ? [tree.archiveBasePath] : []),
    ...(selectedGlobalRun ? [selectedGlobalRun.archiveBasePath] : []),
  ])]
  const archivePathKey = archiveBasePaths.join('\0')

  useEffect(() => {
    void loadGlobalRuns({ workspaceRoot })
  }, [workspaceRoot, loadGlobalRuns])

  useEffect(() => {
    for (const archiveBasePath of archiveBasePaths) {
      void loadArchive({ archiveBasePath, workspaceRoot })
    }
  }, [archivePathKey, workspaceRoot, loadArchive])

  const selectedArchiveBasePath = selected?.tree.archiveBasePath
  const selectedArchiveLoad = selectedArchiveBasePath ? archiveLoads[selectedArchiveBasePath] : undefined
  const selectedResultPath = selectedArchiveBasePath && selected?.node.resultFile
    ? resolveSubagentArchivePath(selectedArchiveBasePath, selected.node.resultFile)
    : undefined
  const selectedEventPath = selectedArchiveBasePath && selected?.tree.eventLog
    ? resolveSubagentArchivePath(selectedArchiveBasePath, selected.tree.eventLog)
    : undefined
  const previewMatchesSelection = preview.status !== 'idle' && (
    preview.nodeKey === selected?.node.key && (
      (preview.kind === 'result' && preview.path === selectedResultPath) ||
      (preview.kind === 'events' && preview.path === selectedEventPath)
    )
  )

  return (
    <section className="agentnew-subagent-panel" aria-label="子 agent 执行树">
      <header className="agentnew-subagent-panel-head">
        <div>
          <strong>子 agent 运行记录</strong>
          <small>实时批次与 workspace 全局历史；归档区回放完整递归树</small>
        </div>
        <span>{liveTrees.length} 次委派</span>
      </header>
      <div className="agentnew-subagent-layout">
        <div className="agentnew-subagent-trees">
          <SkillGovernancePanel workspaceRoot={workspaceRoot} />
          <div className="agentnew-subagent-section-label">
            workspace 历史
            <button type="button" onClick={() => void loadGlobalRuns({ workspaceRoot, force: true })}>刷新</button>
          </div>
          {globalRuns.status === 'idle' || globalRuns.status === 'loading' ? (
            <div className="agentnew-subagent-archive-state">正在读取 run 索引…</div>
          ) : null}
          {globalRuns.status === 'empty' ? (
            <div className="agentnew-subagent-archive-state">{globalRuns.error}</div>
          ) : null}
          {globalRuns.status === 'error' ? (
            <div className="agentnew-subagent-archive-state agentnew-subagent-error">
              run 索引读取失败：{globalRuns.error}
              <button type="button" onClick={() => void loadGlobalRuns({ workspaceRoot, force: true })}>重试</button>
            </div>
          ) : null}
          {globalRuns.status === 'ready' ? (
            <div className="agentnew-subagent-run-list" aria-label="workspace 历史 run">
              {globalRuns.runs.map((run) => (
                <button
                  className={`agentnew-subagent-run${selectedGlobalRun?.key === run.key ? ' active' : ''}`}
                  type="button"
                  aria-pressed={selectedGlobalRun?.key === run.key}
                  key={run.key}
                  onClick={() => {
                    selectNode(undefined)
                    selectGlobalRun({ archiveBasePath: run.archiveBasePath, workspaceRoot })
                    void loadArchive({ archiveBasePath: run.archiveBasePath, workspaceRoot })
                  }}
                >
                  <span><strong>{run.runId}</strong><small>{run.conversationId}</small></span>
                  <span>{run.status}{run.updatedAt ? <time dateTime={run.updatedAt}>{new Date(run.updatedAt).toLocaleString()}</time> : null}</span>
                </button>
              ))}
              {globalRuns.hasMore ? (
                <button
                  className="agentnew-subagent-entry"
                  type="button"
                  disabled={globalRuns.loadingMore}
                  onClick={() => void loadGlobalRuns({ workspaceRoot, loadMore: true })}
                >{globalRuns.loadingMore ? '正在加载更多…' : '加载更多历史 run'}</button>
              ) : null}
            </div>
          ) : null}
          {globalRuns.warnings.map((warning) => (
            <div className="agentnew-subagent-archive-warning" key={warning}>{warning}</div>
          ))}
          {liveTrees.length > 0 ? <div className="agentnew-subagent-section-label">实时批次</div> : null}
          {liveTrees.map((tree) => (
            <TreeView tree={tree} selectedKey={selected?.node.key} onSelect={selectNode} key={tree.id} />
          ))}
          {archiveBasePaths.length > 0 ? <div className="agentnew-subagent-section-label">完整归档树</div> : null}
          {archiveBasePaths.map((archiveBasePath) => {
            const load = archiveLoads[archiveBasePath]
            if (!load || load.status === 'loading') {
              return <div className="agentnew-subagent-archive-state" key={archiveBasePath}>正在读取归档…</div>
            }
            if (load.status === 'empty') {
              return <div className="agentnew-subagent-archive-state" key={archiveBasePath}>暂无归档：{load.error}</div>
            }
            if (load.status === 'error') {
              return (
                <div className="agentnew-subagent-archive-state agentnew-subagent-error" key={archiveBasePath}>
                  归档读取失败：{load.error}
                  <button type="button" onClick={() => void loadArchive({ archiveBasePath, workspaceRoot, force: true })}>重试</button>
                </div>
              )
            }
            const tree = archiveTrees.find((candidate) => candidate.archiveBasePath === archiveBasePath)
            return tree ? <TreeView tree={tree} selectedKey={selected?.node.key} onSelect={selectNode} key={tree.id} /> : null
          })}
        </div>
        {selected ? (
          <aside className="agentnew-subagent-detail" aria-label="子 agent 节点详情">
            <div className="agentnew-subagent-detail-head">
              <code>{selected.node.path}</code>
              <StatusBadge status={selected.node.status} />
            </div>
            <strong>{selected.node.objective}</strong>
            {selected.node.summary ? <p>{selected.node.summary}</p> : null}
            {selected.node.error ? <p className="agentnew-subagent-error">{selected.node.error}</p> : null}
            {selected.node.resultFile ? (
              <div className="agentnew-subagent-meta">
                结果：<code>{selected.node.resultFile}</code>
                {selectedArchiveBasePath ? (
                  <button
                    type="button"
                    onClick={() => void loadPreview({
                      archiveBasePath: selectedArchiveBasePath,
                      path: selected.node.resultFile!,
                      kind: 'result',
                      nodeKey: selected.node.key,
                      workspaceRoot,
                    })}
                  >查看结果</button>
                ) : null}
              </div>
            ) : null}
            {selected.tree.archiveBasePath ? (
              <div className="agentnew-subagent-meta">
                归档：<code>{selected.tree.archiveBasePath}</code>
              </div>
            ) : null}
            {selected.node.skillFiles.length > 0 ? (
              <div className="agentnew-subagent-meta">技能产物：{selected.node.skillFiles.length}</div>
            ) : null}
            {selectedArchiveBasePath && selected.tree.eventLog ? (
              <button
                className="agentnew-subagent-entry"
                type="button"
                onClick={() => void loadPreview({
                  archiveBasePath: selectedArchiveBasePath,
                  path: selected.tree.eventLog!,
                  kind: 'events',
                  nodeKey: selected.node.key,
                  workspaceRoot,
                  content: selectedArchiveLoad?.eventsText,
                })}
              >查看事件日志</button>
            ) : null}
            {selected.tree.source === 'archive' && selectedArchiveBasePath ? (
              <button
                className="agentnew-subagent-entry"
                type="button"
                onClick={() => void loadArchive({ archiveBasePath: selectedArchiveBasePath, workspaceRoot, force: true })}
              >刷新归档</button>
            ) : null}
            {previewMatchesSelection ? (
              <div className="agentnew-subagent-preview" role="region" aria-label="归档文件预览">
                <strong>{preview.kind === 'events' ? '事件日志' : '结果文件'}</strong>
                {preview.path ? <code>{preview.path}</code> : null}
                {preview.status === 'loading' ? <p>读取中…</p> : null}
                {preview.status === 'error' ? <p className="agentnew-subagent-error">{preview.error}</p> : null}
                {preview.status === 'ready' ? <pre>{preview.content || '（空文件）'}</pre> : null}
              </div>
            ) : null}
          </aside>
        ) : (
          <div className="agentnew-subagent-detail agentnew-subagent-detail--empty">选择节点查看详情</div>
        )}
      </div>
    </section>
  )
}
