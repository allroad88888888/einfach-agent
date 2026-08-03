import { useAtomValue } from '@einfach/react'
import { useEffect } from 'react'
import {
  archiveSubagentTreesAtom,
  globalSubagentRunsAtom,
  resolveSubagentArchivePath,
  selectedSubagentNodeAtom,
  selectedGlobalSubagentRunAtom,
  subagentArchiveLoadsAtom,
  subagentArchivePreviewAtom,
  subagentTraceAtom,
  subagentTreesAtom,
  type SubagentTreeView as SubagentTree,
} from '@web-agent/core/state/subagentViewAtoms'
import {
  loadGlobalSubagentRuns,
  loadSubagentArchive,
  loadSubagentArchivePreview,
  loadSubagentTrace,
  selectGlobalSubagentRun,
  selectSubagentNode,
} from '@web-agent/core/runtime/commands'
import { SubagentRunTrace } from './SubagentRunTrace'
import { SubagentSkillGovernancePanel } from './SubagentSkillGovernancePanel'
import { SubagentStatusBadge, SubagentTreeView } from './SubagentTreeView'

function SubagentTreePanelContent({
  liveTrees,
  workspaceRoot,
}: {
  liveTrees: SubagentTree[]
  workspaceRoot?: string
}) {
  const globalRuns = useAtomValue(globalSubagentRunsAtom)
  const globalSelection = useAtomValue(selectedGlobalSubagentRunAtom)
  const archiveTrees = useAtomValue(archiveSubagentTreesAtom)
  const archiveLoads = useAtomValue(subagentArchiveLoadsAtom)
  const preview = useAtomValue(subagentArchivePreviewAtom)
  const trace = useAtomValue(subagentTraceAtom)
  const selected = useAtomValue(selectedSubagentNodeAtom)
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
    void loadGlobalSubagentRuns({ workspaceRoot })
  }, [workspaceRoot])

  useEffect(() => {
    for (const archiveBasePath of archiveBasePaths) {
      void loadSubagentArchive({ archiveBasePath, workspaceRoot })
    }
  }, [archivePathKey, workspaceRoot])

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
  const traceMatchesSelection = trace.status !== 'idle' && trace.nodeKey === selected?.node.key

  useEffect(() => {
    if (!selectedArchiveBasePath || !selected) return
    const input = {
      archiveBasePath: selectedArchiveBasePath,
      agentPath: selected.node.path,
      nodeKey: selected.node.key,
      workspaceRoot,
    }
    void loadSubagentTrace(input)
    if (selected.node.status !== 'running' && selected.node.status !== 'distilling') return
    const timer = window.setInterval(() => {
      void loadSubagentTrace({ ...input, silent: true })
    }, 1_500)
    return () => window.clearInterval(timer)
  }, [
    selectedArchiveBasePath,
    selected?.node.key,
    selected?.node.path,
    selected?.node.status,
    workspaceRoot,
  ])

  return (
    <details className="agentnew-subagent-panel">
      <summary className="agentnew-subagent-panel-head">
        <div>
          <strong>子 agent 运行记录</strong>
          <small>点击展开运行详情</small>
        </div>
        <span>{liveTrees.length} 次委派 <i aria-hidden="true">⌄</i></span>
      </summary>
      <div className="agentnew-subagent-layout">
        <div className="agentnew-subagent-trees">
          <SubagentSkillGovernancePanel workspaceRoot={workspaceRoot} />
          <div className="agentnew-subagent-section-label">
            workspace 历史
            <button type="button" onClick={() => void loadGlobalSubagentRuns({ workspaceRoot, force: true })}>刷新</button>
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
              <button type="button" onClick={() => void loadGlobalSubagentRuns({ workspaceRoot, force: true })}>重试</button>
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
                    selectSubagentNode(undefined)
                    selectGlobalSubagentRun({ archiveBasePath: run.archiveBasePath, workspaceRoot })
                    void loadSubagentArchive({ archiveBasePath: run.archiveBasePath, workspaceRoot })
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
                  onClick={() => void loadGlobalSubagentRuns({ workspaceRoot, loadMore: true })}
                >{globalRuns.loadingMore ? '正在加载更多…' : '加载更多历史 run'}</button>
              ) : null}
            </div>
          ) : null}
          {globalRuns.warnings.map((warning) => (
            <div className="agentnew-subagent-archive-warning" key={warning}>{warning}</div>
          ))}
          {liveTrees.length > 0 ? <div className="agentnew-subagent-section-label">实时批次</div> : null}
          {liveTrees.map((tree) => (
            <SubagentTreeView tree={tree} selectedKey={selected?.node.key} onSelect={selectSubagentNode} key={tree.id} />
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
                  <button type="button" onClick={() => void loadSubagentArchive({ archiveBasePath, workspaceRoot, force: true })}>重试</button>
                </div>
              )
            }
            const tree = archiveTrees.find((candidate) => candidate.archiveBasePath === archiveBasePath)
            return tree ? <SubagentTreeView tree={tree} selectedKey={selected?.node.key} onSelect={selectSubagentNode} key={tree.id} /> : null
          })}
        </div>
        {selected ? (
          <aside className="agentnew-subagent-detail" aria-label="子 agent 节点详情">
            <div className="agentnew-subagent-detail-head">
              <code>{selected.node.path}</code>
              <SubagentStatusBadge status={selected.node.status} />
            </div>
            <strong>{selected.node.objective}</strong>
            {selected.node.error ? <p className="agentnew-subagent-error">{selected.node.error}</p> : null}
            <div className="agentnew-subagent-trace-state">
              {!selectedArchiveBasePath ? <p>运行轨迹归档初始化后显示。</p> : null}
              {selectedArchiveBasePath && (!traceMatchesSelection || trace.status === 'loading') ? <p>正在读取完整运行轨迹…</p> : null}
              {traceMatchesSelection && trace.status === 'ready' ? <SubagentRunTrace records={trace.records} /> : null}
              {traceMatchesSelection && trace.status === 'empty' ? (
                <p>此节点没有完整模型轨迹；旧版本归档只保留了结果与事件摘要。</p>
              ) : null}
              {traceMatchesSelection && trace.status === 'error' ? (
                <p className="agentnew-subagent-error">运行轨迹读取失败：{trace.error}</p>
              ) : null}
              {traceMatchesSelection ? trace.warnings.map((warning) => (
                <p className="agentnew-subagent-archive-warning" key={warning}>{warning}</p>
              )) : null}
            </div>
            <details className="agentnew-subagent-attachments">
              <summary>摘要与产物 <span>{selected.node.skillFiles.length + (selected.node.resultFile ? 1 : 0)}</span></summary>
              {selected.node.summary ? <p>{selected.node.summary}</p> : null}
              {selected.node.resultFile ? (
                <div className="agentnew-subagent-meta">
                  结果：<code>{selected.node.resultFile}</code>
                  {selectedArchiveBasePath ? (
                    <button
                      type="button"
                      onClick={() => void loadSubagentArchivePreview({
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
                  onClick={() => void loadSubagentArchivePreview({
                    archiveBasePath: selectedArchiveBasePath,
                    path: selected.tree.eventLog!,
                    kind: 'events',
                    nodeKey: selected.node.key,
                    workspaceRoot,
                    content: selectedArchiveLoad?.eventsText,
                  })}
                >查看事件日志</button>
              ) : null}
            </details>
            {selected.tree.source === 'archive' && selectedArchiveBasePath ? (
              <button
                className="agentnew-subagent-entry"
                type="button"
                onClick={() => void loadSubagentArchive({ archiveBasePath: selectedArchiveBasePath, workspaceRoot, force: true })}
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
    </details>
  )
}

export function SubagentTreePanel({ workspaceRoot }: { workspaceRoot?: string }) {
  const liveTrees = useAtomValue(subagentTreesAtom)

  if (liveTrees.length === 0) return null

  return <SubagentTreePanelContent liveTrees={liveTrees} workspaceRoot={workspaceRoot} />
}
