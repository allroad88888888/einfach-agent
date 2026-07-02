// runtime/toolExecution.ts（agentNew · 从旧 src/agent/runtime/loop.ts 的
// runRuntimeTool / executeRuntimeToolCall / normalize* / format* 移植裁剪）。
// ---------------------------------------------------------------------------
// FEATURES-PLAN §1 TK6：这里是 tool 执行的副作用边界。model 发起一次 runtime
// 工具调用后，由 tool 循环调用 runRuntimeTool，得到「tool result 的 JSON 字符串」
// 回给 model 继续决策。契约：
//   · 分发不含 ask_user_question —— 那个由 tool 循环内联处理（暂停 run、收答案）。
//   · 副作用只落到 transientAtoms（addPendingArtifact / addBrowserCard），经其
//     ghost guard（会话未登记 → no-op）；本文件另做 stale guard 提前挡掉。
//   · TK6 失败降级：任何分支内部异常 catch 成 { error: message } JSON 返回，绝不抛；
//     唯一例外是 AbortError —— 透传 rethrow，交给上层 run 状态机降级为 stopped。
// 本文件只 import skills registry + 状态层，不 import UI。

import { searchSkills, readSkill } from '../skills/registry'
import { addPendingArtifact, addBrowserCard } from '../state/transientAtoms'
import { rootStore, sessionsAtom } from '../state/rootStore'
import { newId } from './newId'

/**
 * 执行一次 model 发起的 runtime 工具调用，返回 tool result 的 JSON 字符串。
 *
 * @param id       会话 id（副作用落到该会话 store；stale guard 也查它是否登记）。
 * @param toolName 工具名（ask_user_question 不在此处理）。
 * @param args     已收窄成 Record 的工具参数。
 * @param ctx      runId + signal（browser_action 的 stale guard 用 signal.aborted）。
 */
export async function runRuntimeTool(
  id: string,
  toolName: string,
  args: Record<string, unknown>,
  ctx: { runId: string; signal: AbortSignal },
): Promise<string> {
  try {
    switch (toolName) {
      case 'skill_search': {
        const query = String(args.query ?? '')
        return JSON.stringify({ query, results: searchSkills(query) })
      }

      case 'skill_read': {
        const name = String(args.name ?? '')
        const skill = readSkill(name)
        return JSON.stringify(skill ? { name, skill } : { error: `skill not found: ${name}` })
      }

      case 'save_file':
        return runSaveFile(id, args, ctx.signal)

      case 'browser_action':
        return runBrowserAction(id, args, ctx.signal)

      default:
        return errorResult(`unknown tool: ${toolName}`)
    }
  } catch (error) {
    // TK6：AbortError 透传，其它一律降级成 error JSON，绝不把异常抛给 tool 循环。
    if (isAbortError(error)) throw error
    return errorResult(error instanceof Error ? error.message : String(error))
  }
}

// save_file（§1.5）：同步暂存 artifact（不开 picker、不暂停 loop），返回 readiness
// JSON 回给 model。PF5：空文件（content === ''）合法，只要求非空 filename + content 是 string。
function runSaveFile(id: string, args: Record<string, unknown>, signal: AbortSignal): string {
  // §1.3 stale-run guard：被打断 / 会话已不在登记表 → 拒绝暂存 artifact，避免 stale run
  // 产生虚假的 accepted:true（与 browser_action 一致）。addPendingArtifact 的 ghost guard
  // 也会 no-op，这里提前挡是为了返回明确的 stale 而非 accepted:true。
  if (signal.aborted || !rootStore.getter(sessionsAtom)[id]) {
    return errorResult('stale')
  }

  const filename = typeof args.filename === 'string' ? args.filename.trim() : ''
  const hasStringContent = typeof args.content === 'string'
  const content = hasStringContent ? (args.content as string) : ''
  const mimeType = typeof args.mimeType === 'string' && args.mimeType.trim() ? args.mimeType.trim() : undefined

  if (!filename || !hasStringContent) {
    return errorResult('invalid save_file: filename (non-empty) and string content are required')
  }

  const artifactId = newId()
  addPendingArtifact(id, { id: artifactId, filename, content, mimeType })
  return JSON.stringify({ accepted: true, artifactId, bytes: content.length })
}

// browser_action（§1.2–1.5）：唯一 action 是 render_card。规范化 payload（title 必填、
// body 可选）→ stale guard（signal.aborted 或 会话未登记 → {error:'stale'} 且不写）→
// 写卡片。绝不 append 任何 assistant 消息 —— 卡片不持久化，靠 model 下一轮文字概括。
function runBrowserAction(id: string, args: Record<string, unknown>, signal: AbortSignal): string {
  const action = typeof args.action === 'string' ? args.action : undefined
  if (action !== 'render_card') {
    return errorResult(`unsupported browser_action: ${action ?? '(missing)'}`)
  }

  const card = normalizeCardPayload(args.payload)
  if (!card) {
    return errorResult('invalid browser_action payload: title (non-empty string) is required')
  }

  // §1.3 stale-run guard：被打断 / 会话已不在登记表 → 拒绝落卡片，避免 stale run
  // 产生虚假的 ok:true。会话未登记时 addBrowserCard 的 ghost guard 也会 no-op，
  // 这里提前挡是为了返回明确的 stale 而非 ok:true。
  if (signal.aborted || !rootStore.getter(sessionsAtom)[id]) {
    return errorResult('stale')
  }

  const cardId = newId()
  addBrowserCard(id, { id: cardId, createdAt: Date.now(), title: card.title, body: card.body })
  return JSON.stringify({
    ok: true,
    cardId,
    note: '卡片不持久化，请在最终回复里文字概括其内容',
  })
}

// §1.4 strict normalize：title 必须是非空字符串；body 可选字符串。新 BrowserCard 只
// 承载 title/body（不含 items/options），无法规范化时返回 undefined（=> error，不写 atom）。
function normalizeCardPayload(payload: unknown): { title: string; body?: string } | undefined {
  const value = asRecord(payload)
  const title = typeof value.title === 'string' ? value.title.trim() : ''
  if (!title) return undefined

  const card: { title: string; body?: string } = { title }
  if (typeof value.body === 'string' && value.body.trim()) {
    card.body = value.body
  }
  return card
}

// 把未知 payload 安全视为普通对象（非对象 / 数组 → 空对象），避免直接取字段崩。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

// 把 runtime 工具错误包装成 JSON —— 工具失败不打断 tool 循环，作为 tool result 回传。
function errorResult(message: string): string {
  return JSON.stringify({ error: message })
}

// AbortError 判定：name === 'AbortError'（DOMException 或普通 Error 皆可）。
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
