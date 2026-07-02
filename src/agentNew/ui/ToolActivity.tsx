// 工具进度条（P-progress）——在「当前会话 store」的 Provider 下，读 toolActivityAtom 渲染。
// ---------------------------------------------------------------------------
// 契约（U1）：只读 atom（toolActivityAtom）+ 不 setter/不碰 store/不调命令。
// 显示「哪个工具调用正在干啥」——harness 经 ctx.progress 写入、工具跑完清掉；空则不渲染。

import { useAtomValue } from '@einfach/react'
import { toolActivityAtom } from '../state/transientAtoms'

export function ToolActivity() {
  const activities = useAtomValue(toolActivityAtom)
  if (activities.length === 0) return null

  return (
    <div className="agentnew-tool-activity" aria-label="工具进度" role="status">
      {activities.map((activity) => (
        <div key={activity.callId} className="agentnew-tool-activity-row">
          <span className="agentnew-tool-activity-spinner" aria-hidden="true">
            ⚙
          </span>
          <span className="agentnew-tool-activity-name">{activity.toolName}</span>
          <span className="agentnew-tool-activity-text">{activity.text}</span>
        </div>
      ))}
    </div>
  )
}
