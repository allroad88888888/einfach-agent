// S4-B ToolConfirmCard：run 因「危险（变更类）工具」暂停等确认时渲染的确认卡片。
// ---------------------------------------------------------------------------
// 契约 U1 —— 只做两件事：读 atom（runAtom）+ 调命令（confirmTool）。绝不直接 setter atom、
//   不 import writers、不碰 store 实例。U3：挂在「当前会话 store」的 Provider 下，读到的是该会话的 run。
// 镜像 AskUserQuestionCard：仅当 run 停在 waiting_confirmation 且挂着 pendingToolConfirmation 才渲染。
// pendingToolConfirmation.args 是模型给的原样参数（unknown），预览前防御式提取（command/path），并安全截断。

import { useState } from 'react'
import { useAtomValue } from '@einfach/react'
import { runAtom, confirmTool } from '@web-agent/core'
import { isMcpTool } from '@web-agent/core/runtime/dangerousTools'

const PREVIEW_MAX = 240

// 「纯对象」判定：排除 null 与数组。
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

// 安全截断（超长加省略号）。
function truncate(text: string): string {
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text
}

// 从原样 args 里防御式提取一段「人看得懂」的预览：shell → command；写/patch → path(s)；兜底 → JSON。
function describeArgs(args: unknown): string {
  const record = asRecord(args)
  if (!record) return ''

  if (typeof record.command === 'string' && record.command.trim()) {
    return truncate(record.command.trim())
  }
  if (typeof record.path === 'string' && record.path.trim()) {
    return truncate(record.path.trim())
  }
  // apply_patch：operations 数组 → 列出涉及的文件路径。
  if (Array.isArray(record.operations)) {
    const paths = record.operations
      .map((op) => asRecord(op)?.path)
      .filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
    if (paths.length > 0) return truncate(paths.join('、'))
  }

  try {
    return truncate(JSON.stringify(args))
  } catch {
    return ''
  }
}

export function ToolConfirmCard() {
  const run = useAtomValue(runAtom)

  // 仅当当前会话 run 停在 waiting_confirmation 且挂着 pendingToolConfirmation 才渲染，否则不占位。
  if (run?.status !== 'waiting_confirmation' || !run.pendingToolConfirmation) return null

  const { callId, toolName, args, risk, reason, irreversible } = run.pendingToolConfirmation
  // key={callId}：每次确认都是新的 callId → 整卡重挂，「一律允许」等本地态天然复位。
  // 否则组件在两次确认之间只是 return null 仍保持挂载，上一次的勾选会泄漏到下一次确认，
  // 让用户没为该工具勾选的「一律允许」被静默生效（codex P2 安全）。
  return <ConfirmCardBody
    key={callId}
    toolName={toolName}
    args={args}
    risk={risk}
    reason={reason}
    irreversible={irreversible}
  />
}

// 单次确认的卡片主体：勾选/按钮等本地态都在这里，靠父组件 key={callId} 保证每次确认复位。
function ConfirmCardBody({
  toolName,
  args,
  risk,
  reason,
  irreversible,
}: {
  toolName: string
  args: unknown
  risk?: 'dangerous' | 'critical'
  reason?: string
  irreversible?: boolean
}) {
  // 「本 session 一律允许该工具」勾选（纯本地 UI 态；确认「允许」时经命令写入瞬态集合）。
  const [always, setAlways] = useState(false)
  const preview = describeArgs(args)
  const canRememberApproval = risk !== 'critical' && !irreversible && !isMcpTool(toolName)

  return (
    <section className="agentnew-confirm" aria-labelledby="agentnew-confirm-title">
      <header className="agentnew-confirm-header">
        <span className="agentnew-confirm-eyebrow">{risk === 'critical' ? '极高风险操作' : '需要确认'}</span>
        <h2 id="agentnew-confirm-title" className="agentnew-confirm-title">
          即将执行工具 <code className="agentnew-confirm-tool">{toolName}</code>
        </h2>
      </header>

      {preview && (
        <pre className="agentnew-confirm-preview" aria-label="工具参数预览">
          {preview}
        </pre>
      )}

      {reason ? <p className="agentnew-confirm-reason">{reason}</p> : null}

      {canRememberApproval ? <label className="agentnew-confirm-always">
        <input
          type="checkbox"
          checked={always}
          onChange={(event) => setAlways(event.target.checked)}
        />
        本 session 一律允许该工具
      </label> : null}

      <footer className="agentnew-confirm-footer">
        <button
          type="button"
          className="agentnew-confirm-reject"
          onClick={() => confirmTool(false)}
        >
          拒绝
        </button>
        <button
          type="button"
          className="agentnew-confirm-approve"
          onClick={() => confirmTool(true, canRememberApproval ? always : false)}
        >
          允许
        </button>
      </footer>
    </section>
  )
}
