// 撤销 / 重做条 —— 会话事务日志的用户入口，紧贴输入区上方。
// ---------------------------------------------------------------------------
// UI 隔离契约（U1）：只做两件事 —— 读一个 atom（sessionUndoAvailabilityAtom）+ 调命令
// （undoTurn / redoTurn）。绝不 setter atom、不 import writer、不碰 History 本体
// （后者带 undo/record/transaction，等于把改状态和记账的权限递进渲染层）。
//
// **可用态不在这里判**。「什么情况下不能撤销」是策略，真相在 state/sessionHistory.ts 的派生 atom：
// 若这里自己去读 run 状态判一遍，那份状态列表就有了第二份副本，两边一漂移就会出现
// 「按钮能点，命令却拒绝」。所以本组件只把派生结果映射成 disabled 与提示文案。
//
// 粒度取「一整轮」而不是「一条」：一轮对话会产生十几条细粒度账目（追加用户消息、改 run 状态、
// 回填工具结果…），按条撤销对用户没有意义。逐条那档（undoEntry）留给开发者，不进 UI。

import { useAtomValue } from '@einfach/react'
import { redoTurn, sessionUndoAvailabilityAtom, undoTurn } from '@web-agent/core'

/** 有账可退但**永久**不许退时，告诉用户为什么。 */
const BLOCKED_HINT = {
  // 更早那一段引用的上传已被真正删除，撤销回去只会得到坏引用。
  irreversible_barrier: '更早的内容已释放，无法继续撤销',
} as const

export function UndoBar({ sessionId }: { sessionId: string }) {
  const availability = useAtomValue(sessionUndoAvailabilityAtom(sessionId))
  const hint = availability.blocked ? BLOCKED_HINT[availability.blocked] : undefined
  // run 在飞时按钮照常可点 —— 命令会替用户停掉它。但必须先说出来，别让「停止」变成暗箱动作。
  const stopNotice = availability.willStopRun ? '会先停止当前运行' : undefined

  // 一条账都没有（新会话、或已退到底又没得重做）→ 整体不显示，别在界面上摆两个永远灰着的按钮。
  if (!availability.canUndo && !availability.canRedo && !hint) return null

  return (
    <div className="agentnew-undo-bar" aria-label="撤销与重做">
      <button
        type="button"
        className="agentnew-undo-item"
        disabled={!availability.canUndo}
        title={hint ?? stopNotice ?? '把最近一轮对话整体退回'}
        onClick={() => { undoTurn() }}
      >
        撤销上一轮
      </button>
      <button
        type="button"
        className="agentnew-undo-item"
        disabled={!availability.canRedo}
        title={hint ?? stopNotice ?? '把刚撤销的那一轮重做回来'}
        onClick={() => { redoTurn() }}
      >
        重做
      </button>
      {hint ?? stopNotice ? (
        <span className="agentnew-undo-hint">{hint ?? stopNotice}</span>
      ) : null}
    </div>
  )
}
