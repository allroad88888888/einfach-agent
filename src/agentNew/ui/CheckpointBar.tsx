// P-U5：CheckpointBar —— 右栏「回退到某一轮」的可点轮列表（在会话 store 的 Provider 下）。
// ---------------------------------------------------------------------------
// UI 隔离契约（U1）：只做两件事 —— 读 atom（checkpointsAtom / currentTurnIndexAtom）+
// 调命令（revertToTurn）。绝不 setter atom / import writers / 碰 store 实例。
// 没有 checkpoint 就整体不显示（return null）。

import { useAtomValue } from '@einfach/react'
import { checkpointsAtom, currentTurnIndexAtom } from '../state/sessionAtoms'
import { revertToTurn } from '../runtime/commands'

export function CheckpointBar() {
  const checkpoints = useAtomValue(checkpointsAtom)
  const current = useAtomValue(currentTurnIndexAtom)

  // 没有轮就不显示。
  if (checkpoints.length === 0) return null

  return (
    <div className="agentnew-checkpoint-bar">
      {checkpoints.map((cp) => {
        const label = cp.label || `第 ${cp.turnIndex + 1} 轮`
        const isActive = cp.turnIndex === current
        return (
          <button
            key={cp.turnIndex}
            className={isActive ? 'agentnew-checkpoint-item active' : 'agentnew-checkpoint-item'}
            onClick={() => revertToTurn(cp.turnIndex)}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
