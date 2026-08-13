import type { CSSProperties } from 'react'
import type { SubagentTreeView, SubagentTreeViewNode } from '@web-agent/subagents'

const STATUS_LABEL: Record<SubagentTreeViewNode['status'], string> = {
  queued: '排队',
  distilling: '提炼',
  running: '运行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

export function SubagentStatusBadge({ status }: { status: SubagentTreeViewNode['status'] }) {
  return (
    <span className={`agentnew-subagent-status agentnew-subagent-status--${status}`}>
      {STATUS_LABEL[status]}
    </span>
  )
}

/** Presents a single live or archived subagent tree. */
export function SubagentTreeView({
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
          <SubagentStatusBadge status={node.status} />
        </button>
      ))}
      {tree.warnings?.map((warning) => (
        <div className="agentnew-subagent-archive-warning" key={warning}>{warning}</div>
      ))}
    </div>
  )
}
