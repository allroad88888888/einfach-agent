// 多轮 lazy-tool 对话 run —— 把用户输入送模型，按 model 决策循环调工具，直到最终答案。
// ---------------------------------------------------------------------------
// 契约（FEATURES-PLAN §1 T-6/T-7）：单轮 → 多轮 tool 循环 + ask_user 暂停/恢复。
//   · TK1 itemsAtom 直存：assistant(tool_calls) 与 tool result 直接 appendItem 进 itemsAtom，
//     每轮重新 `items.map(it=>it.item)` 重发；不用 continuation blob。
//   · TK3 manifest-only + lazy schema：model 只看 request_tool_schema + 本轮已加载 visible tools；
//     完整 schema 经 ensureToolLoaded 懒加载，禁止预加载。
//   · TK4 skill 走 tool：system 只放已加载 skill 名（buildSystemItem），内容不进 prompt。
//   · TK6 tool 错误不打断：runRuntimeTool 内部把失败封 {error} JSON 回给 model，loop 继续。
//   · TK7 ask_user「已回答」守卫：resume 后 model 再要求提问不再暂停（回 user_answers_already_provided）。
//   · TK8 每步守卫：每次 model 调用后写回前 isCurrentRun + ghost guard；MAX_AGENT_TURNS 上限。
//   · TK9 一轮 = 一个 checkpoint：中间 tool items 属同一轮，最终 assistant 后 commit 一次。
//   · U7 signal 全穿透 + 失败降级：AbortError→'stopped'；其它→'error'；绝不抛崩。
// 本文只编排 writers + api + 纯 helper（modelTurn），不持有/接收 store（U2），不 import UI（U1）。

import { rootStore, sessionsAtom } from '../state/rootStore'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom, checkpointsAtom } from '../state/sessionAtoms'
import { appendItem, setRun, patchRun } from '../state/sessionWriters'
import { commitCheckpoint } from '../state/checkpointWriters'
import { removeToolActivity } from '../state/transientAtoms'
import { persistCheckpoint, persistSessions } from './persistenceBridge'
import { callDeepSeek } from '../api/deepseek'
import { callGlm } from '../api/glm'
import type { ModelChatResponse } from '../api/modelApi'
import { toolRegistry } from '../tools/registry'
import type { LoadedTool, ToolResult } from '../tools/types'
import '../tools/register' // 副作用：把内置工具注册进 toolRegistry（运行时任何用工具的路径都经 modelRun）。
import { ensureToolLoaded } from './toolLoading'
import { buildToolContext } from './toolContext'
import { buildSystemItem, buildTurnTools, narrowToolCalls, safeParseArgs } from './modelTurn'
import { newId } from './newId'

// 循环上限保护（TK8）：防止 model 无限请求工具 / 死循环，超限降级为 error。
const MAX_AGENT_TURNS = 12

// stale-run 守卫：会话仍登记，且该会话当前 run 就是本次 runId（未被新 run 顶掉）。
function isCurrentRun(id: string, runId: string): boolean {
  if (!rootStore.getter(sessionsAtom)[id]) return false
  return getSessionStore(id).store.getter(runAtom)?.runId === runId
}

// 取「本轮」——itemsAtom 里最后一条 user 之后的 items（含那条 user）。
// 一轮以 user 起头；resume 回填的是 ToolItem、不 append user echo，故 resume 续跑的 items
// 仍归上一条 user 那一轮 —— 天然把守卫/输入推断限定在当前这轮，不误伤历史轮。
function currentTurnItems(id: string) {
  const items = getSessionStore(id).store.getter(itemsAtom)
  let start = 0
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].item.role === 'user') {
      start = i
      break
    }
  }
  return items.slice(start)
}

// 驱动本轮的用户文本：本轮起头那条 user 的 content（fresh run 即刚 append 的 input，
// resume 时为暂停前的原始提问）。用于按触发词选 skill 组 system、以及 checkpoint 摘要。
function latestUserInput(id: string): string {
  const first = currentTurnItems(id)[0]?.item
  return first?.role === 'user' ? first.content : ''
}

// TK7「已回答」守卫判定：本轮 items 里是否已有「ask_user 的 ToolItem 回填」——
// 即某条 assistant.tool_calls 里 name==='ask_user_question' 的 id，已被某条 role:'tool' 回填。
// 命中说明用户答案已提供过（resume 已续跑），此时 model 再要求提问不应再暂停（防死循环）。
function askAlreadyAnswered(id: string): boolean {
  const turn = currentTurnItems(id)
  const askIds = new Set<string>()
  for (const { item } of turn) {
    if (item.role === 'assistant' && item.tool_calls) {
      for (const toolCall of item.tool_calls) {
        if (toolCall.function.name === 'ask_user_question') askIds.add(toolCall.id)
      }
    }
  }
  if (askIds.size === 0) return false
  return turn.some((it) => it.item.role === 'tool' && askIds.has(it.item.tool_call_id))
}

// 简介：跑一轮多轮 lazy-tool 对话 run（T-6）。
// 详情：append user → setRun('running') → 交给 runToolLoop 驱动多轮循环（与 resume 同一入口）。
export async function runSession(
  id: string,
  input: string,
  opts: { signal: AbortSignal; apiKey: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const runId = newId()

  // 追加用户输入 + 起 run（会话未登记时二者均 no-op，见 sessionWriters ghost guard）。
  appendItem(id, { id: newId(), createdAt: Date.now(), item: { role: 'user', content: input } })
  setRun(id, { runId, status: 'running' })

  // 与 resume 复用同一循环入口（此时最后一条 user 就是刚 append 的 input，行为与旧版等价）。
  await runToolLoop(id, runId, opts)
}

// 简介：多轮 lazy-tool 循环入口（T-6/T-7 复用）—— 不 append user、不 setRun，
//   假定调用方（runSession 起新 run / resumeWithAnswers 续 pending run）已备好 items 与 run。
// 详情：组 system（不入库，按本轮起头 user 选 skill）→ 多轮循环：每轮重发
//   [system, ...items] + [request_tool_schema, ...visible]，按响应有无 tool_calls 分流：
//   有 → append assistant(tool_calls) + 逐个执行工具 append ToolItem → 续轮；
//   无 → 空回复守卫 → append 最终 assistant → commitCheckpoint → done。
//   ask_user_question 内联暂停（waiting_user + pendingQuestion）并 return；已答过则续跑（TK7）；
//   超上限 → error。失败降级（U7）：AbortError→'stopped'；其它→'error'。绝不抛出。
export async function runToolLoop(
  id: string,
  runId: string,
  opts: { signal: AbortSignal; apiKey: string; fetchImpl?: typeof fetch },
): Promise<void> {
  // ghost guard：会话未登记 → 直接返回（不发请求、不写入）。同时收窄 meta 供后续取 settings。
  const meta = rootStore.getter(sessionsAtom)[id]
  if (!meta) return

  // 本轮驱动输入取自 itemsAtom（不由参数传入）：fresh run = 刚 append 的 user；resume = 原始提问。
  const input = latestUserInput(id)

  // system 只用于请求、不入库（TK4）：按输入选 skill，system 只列已加载 skill 名。
  const system = buildSystemItem(input)
  // thinking：状态层 boolean → 线协议 { type:'enabled'|'disabled' }。区分三态（codex P2）：
  //   undefined → 不传（用服务端默认）；true → enabled；false → disabled（显式关思考，
  //   否则 reasoning-默认-开 的 provider 会无视用户的关闭设置）。
  const thinking =
    meta.settings.thinking === undefined
      ? undefined
      : ({ type: meta.settings.thinking ? 'enabled' : 'disabled' } as const)
  const callOptions = { apiKey: opts.apiKey, signal: opts.signal, fetchImpl: opts.fetchImpl }

  // 本轮可见工具（懒加载累积）：只有出现在此的 schema 才暴露给下一轮 model（TK3）。
  let visible: LoadedTool[] = []

  try {
    for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
      // 每轮重新 map itemsAtom（含上一轮 append 的 assistant/tool items），TK1。
      const items = getSessionStore(id).store.getter(itemsAtom)
      const messages = [system, ...items.map((it) => it.item)]
      const tools = buildTurnTools(visible)

      // 按 vendor 收窄 settings 后调 model（透传参数 + tools + tool_choice + signal + fetchImpl）。
      let res: ModelChatResponse
      if (meta.settings.vendor === 'glm') {
        const s = meta.settings
        res = await callGlm(
          {
            model: s.model,
            messages,
            temperature: s.temperature,
            max_tokens: s.max_tokens,
            thinking,
            reasoning_effort: s.reasoning_effort,
            tools,
            tool_choice: 'auto',
          },
          callOptions,
        )
      } else {
        const s = meta.settings
        res = await callDeepSeek(
          {
            model: s.model,
            messages,
            temperature: s.temperature,
            max_tokens: s.max_tokens,
            thinking,
            reasoning_effort: s.reasoning_effort,
            tools,
            tool_choice: 'auto',
          },
          callOptions,
        )
      }

      // TK8 每步守卫：写回前再查会话还在、且仍是本次 run（异步期间可能被删/被顶掉）。
      if (!isCurrentRun(id, runId)) return
      // esc race：fetch 在 abort 前已返回但 signal 已中断 → stopped，不写回。
      if (opts.signal.aborted) {
        if (isCurrentRun(id, runId)) patchRun(id, { status: 'stopped' })
        return
      }

      const msg = res.choices?.[0]?.message
      const toolCalls = narrowToolCalls(msg?.tool_calls)

      // ── 有 tool_calls：先 append assistant(tool_calls)，再补齐「每个 tool_call 都要有对应 tool result」。
      // 关键（codex P2）：若同一条 assistant.tool_calls 里既有合法 ask_user_question 又有其它工具，
      // 必须先把其它工具全执行、补齐 result，最后再处理 ask_user 的暂停/已答 —— 否则一旦提前 return
      // 进 waiting_user，同条消息里其余 tool_call 就缺 tool 消息，resume 重发会被 OpenAI 兼容接口
      // 拒绝（每个 tool_call 必须有匹配的 tool result）。
      if (toolCalls.length > 0) {
        appendItem(id, {
          id: newId(),
          createdAt: Date.now(),
          item: { role: 'assistant', content: msg?.content ?? null, tool_calls: toolCalls },
        })

        const appendToolResult = (toolCallId: string, content: string) =>
          appendItem(id, {
            id: newId(),
            createdAt: Date.now(),
            item: { role: 'tool', tool_call_id: toolCallId, content },
          })

        // 暂停请求（工具返回 {pause}，目前只有 ask_user）——先记着，等同条消息里其它 tool_call 都补齐
        // result 再统一处理。否则提前 return 进 waiting_user 会漏掉其余 tool_call 的 tool 消息，resume
        // 重发被 OpenAI 兼容接口拒（codex P2）。
        let pauseCall: { callId: string; payload: unknown } | undefined

        for (const toolCall of toolCalls) {
          const name = toolCall.function.name
          const args = safeParseArgs(toolCall.function.arguments)

          // request_tool_schema：懒加载 schema+guide 进 visible（累计已载写回 run），回 loadSchema JSON。同步，无需守卫。
          if (name === 'request_tool_schema') {
            const toolName = typeof args.toolName === 'string' ? args.toolName : ''
            visible = ensureToolLoaded(id, visible, toolName)
            appendToolResult(toolCall.id, JSON.stringify(toolRegistry.loadSchema(toolName) ?? { error: 'unknown' }))
            continue
          }

          // 其它工具：建 ctx（副作用白名单）→ 经工厂统一分发 → 拿 ToolResult。
          const ctx = buildToolContext({ sessionId: id, runId, signal: opts.signal, callId: toolCall.id, toolName: name })
          let result: ToolResult
          try {
            result = await toolRegistry.run(name, args, ctx)
          } finally {
            // 无论正常返回还是 AbortError 抛出，都清掉该 tool 的进度条目 —— 否则 stop 后 UI 残留卡住的进度行（codex P2）。
            removeToolActivity(id, toolCall.id)
          }

          // TK8「每步不漏」：execute 可能异步且 signal 穿透其中，await 后写回前再查会话还在、且仍是本次 run；
          // 被顶掉的旧 run 不得把迟到 result 写进新 run；esc 中断则收成 stopped。
          if (!isCurrentRun(id, runId)) return
          if (opts.signal.aborted) {
            if (isCurrentRun(id, runId)) patchRun(id, { status: 'stopped' })
            return
          }

          // 结果映射（§4）：pause 延后处理；ok → data JSON；error → {error} JSON（TK6，不打断）。
          if ('pause' in result) {
            if (pauseCall) {
              // 已有暂停请求 → 这个多余的 pause 补个 result，别让它 orphan。
              appendToolResult(toolCall.id, JSON.stringify({ error: 'already pausing' }))
            } else {
              pauseCall = { callId: toolCall.id, payload: result.pause } // 不 append，留给 resume 回填
            }
          } else if (result.ok) {
            appendToolResult(toolCall.id, JSON.stringify(result.data ?? { ok: true }))
          } else {
            appendToolResult(toolCall.id, JSON.stringify({ error: result.error }))
          }
        }

        // 其它工具已补齐，最后处理暂停：TK7「已回答」守卫 —— resume 后本轮已回填过 ask_user 的 result
        //   → 不再暂停，回 {error:'user_answers_already_provided'} 让 model 用已给答案续跑，防死循环；
        //   否则暂停 run（waiting_user + pendingQuestion），该 tool 的 result 留给 resume 回填。
        if (pauseCall) {
          if (askAlreadyAnswered(id)) {
            appendToolResult(pauseCall.callId, JSON.stringify({ error: 'user_answers_already_provided' }))
          } else {
            patchRun(id, { status: 'waiting_user', pendingQuestion: pauseCall.payload })
            return
          }
        }

        continue
      }

      // ── 无 tool_calls：最终答案。空回复（null/空串/纯空白）当失败，不写、不 commit。
      const content = msg?.content
      if (!content || !content.trim()) {
        if (isCurrentRun(id, runId)) patchRun(id, { status: 'error', error: '模型返回空回复' })
        return
      }

      appendItem(id, { id: newId(), createdAt: Date.now(), item: { role: 'assistant', content } })
      commitCheckpoint(id, input.slice(0, 20)) // TK9：一轮用户输入收尾 = 一个 checkpoint。
      // D-4 持久化接线：把刚提交的这一轮 checkpoint 落盘 + 会话列表落盘（fire-and-forget，DK2）。
      const checkpoints = getSessionStore(id).store.getter(checkpointsAtom)
      const committed = checkpoints[checkpoints.length - 1]
      if (committed) persistCheckpoint(id, committed)
      persistSessions()
      patchRun(id, { status: 'done' })
      return
    }

    // 循环跑满 MAX_AGENT_TURNS 仍未收尾 → 降级为 error（TK8 上限保护）。
    if (isCurrentRun(id, runId)) patchRun(id, { status: 'error', error: '超过最大工具轮数' })
  } catch (err) {
    // U7 降级：被 esc 中断 → 'stopped'（仅当仍是本次 run，避免污染新 run）。
    if (err instanceof DOMException && err.name === 'AbortError') {
      if (isCurrentRun(id, runId)) patchRun(id, { status: 'stopped' })
      return
    }
    // 其它失败 → 'error'（不抛崩 UI；仅当仍是本次 run）。
    if (isCurrentRun(id, runId)) {
      patchRun(id, { status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }
}
