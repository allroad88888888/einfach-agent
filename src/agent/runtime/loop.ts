import type { Store } from '@einfach/core'
import { createMainArchitectPlan } from '../agents/main-architect'
import { mergeArtifacts } from '../agents/deputy-architect'
import { runWorkerTask } from '../agents/workers'
import { createModelAdapter } from '../model'
import { pickSkillsForInput, readSkill, searchSkills } from '../skills/registry'
import { listToolSummaries, loadTool } from '../tools/registry'
import {
  activeSessionIdAtom,
  addPendingArtifact,
  appendMessage,
  appendTimelineEvent,
  clearPendingQuestionAnswers,
  composerDraftAtom,
  createId,
  getConversationMemory,
  getPendingQuestionAnswers,
  messagesBySessionAtom,
  patchRunState,
  runsBySessionAtom,
  sessionsAtom,
  setRunState,
  updateMessage,
  updateTimelineEvent,
} from '../state/atoms'
import { buildConversationContext } from './conversation-context'
import { ASK_USER_PLACEHOLDER_PREFIX, USER_ANSWERS_ECHO_PREFIX } from './types'
import type {
  AgentContext,
  AgentArtifact,
  AgentRunState,
  AskUserAnswers,
  AskUserQuestionItem,
  AskUserQuestionPayload,
  ChatMessage,
  LoadedSkill,
  LoadedTool,
  TimelineEvent,
  TimelineKind,
  WorkerAgentId,
} from './types'
import type {
  AgentTurnContinuation,
  AgentTurnResult,
  AgentTurnToolResult,
  ConversationContext,
  ModelAdapter,
  ModelStreamEvent,
} from '../model'

const activeControllers = new Map<string, AbortController>()
const MAX_AGENT_TURNS = 12

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer)
        reject(new DOMException('Run aborted', 'AbortError'))
      },
      { once: true },
    )
  })

export function startAgentRun(store: Store, input: string) {
  const trimmedInput = input.trim()
  if (!trimmedInput) return

  const sessionId = store.getter(activeSessionIdAtom)
  const runId = createId('run')

  abortSessionRun(sessionId)
  store.setter(composerDraftAtom, '')
  clearPendingQuestionAnswers(store)

  // §0 run boundary: capture the history cutoff BEFORE appending the current-run
  // user message, so this run's own messages never enter conversation memory.
  const historyEndIndex = (store.getter(messagesBySessionAtom)[sessionId] ?? []).length

  appendMessage(store, sessionId, {
    id: createId('msg'),
    role: 'user',
    content: trimmedInput,
    createdAt: Date.now(),
  })

  const run: AgentRunState = {
    id: runId,
    sessionId,
    status: 'running',
    input: trimmedInput,
    loadedSkills: [],
    loadedTools: [],
    historyEndIndex,
  }

  setRunState(store, sessionId, run)
  void executeRun(store, sessionId, runId, trimmedInput, undefined, historyEndIndex)
}

export function continueAgentRunWithAnswers(store: Store) {
  const sessionId = store.getter(activeSessionIdAtom)
  const run = store.getter(runsBySessionAtom)[sessionId]
  if (!run || run.status !== 'waiting_user') return

  const answers = getPendingQuestionAnswers(store)
  clearPendingQuestionAnswers(store)

  appendMessage(store, sessionId, {
    id: createId('msg'),
    role: 'user',
    content: formatUserAnswers(answers),
    createdAt: Date.now(),
    // MF7: structural marker so this "已补充:" echo is excluded from history by
    // marker, never by its content prefix.
    scaffold: 'answer-echo',
  })

  patchRunState(store, sessionId, {
    status: 'running',
    pendingQuestion: undefined,
  })

  // §0: AskUser resume reuses the SAME run boundary captured at run start, so
  // the placeholder/"已补充:" messages stay out of conversation memory.
  void executeRun(store, sessionId, run.id, run.input, answers, run.historyEndIndex)
}

export function stopActiveRun(store: Store) {
  const sessionId = store.getter(activeSessionIdAtom)
  const run = store.getter(runsBySessionAtom)[sessionId]
  if (!run || run.status !== 'running') return

  abortSessionRun(sessionId)
  patchRunState(store, sessionId, { status: 'stopped' })
  addTimeline(store, sessionId, run.id, 'system', 'Run stopped', 'User stopped the active run.', 'stopped')
}

/**
 * RF2: cancel any in-flight run for a session before it is deleted. Aborts the
 * controller (so pending awaits reject with AbortError and the executor bails)
 * and marks the run stopped. Safe to call even if no run is active. Callers
 * (e.g. `deleteSession` via the UI) invoke this *before* removing the session.
 */
export function cancelSessionRun(store: Store, sessionId: string) {
  abortSessionRun(sessionId)
  const run = store.getter(runsBySessionAtom)[sessionId]
  if (run && (run.status === 'running' || run.status === 'waiting_user')) {
    patchRunState(store, sessionId, { status: 'stopped' })
  }
}

async function executeRun(
  store: Store,
  sessionId: string,
  runId: string,
  input: string,
  answerContext?: AskUserAnswers,
  historyEndIndex?: number,
) {
  const controller = new AbortController()
  activeControllers.set(sessionId, controller)
  const signal = controller.signal

  try {
    const mainEventId = addTimeline(
      store,
      sessionId,
      runId,
      'agent',
      'MainArchitectAgent',
      'Planning worker tasks.',
      'running',
      'main-architect',
    )
    await wait(180, signal)
    const plan = createMainArchitectPlan(input)
    updateTimelineEvent(store, sessionId, mainEventId, {
      detail: plan.summary,
      status: 'done',
    })

    const loadedSkills = pickSkillsForInput(input)
    patchRunState(store, sessionId, {
      loadedSkills: loadedSkills.map((skill) => skill.name),
    })

    if (loadedSkills.length) {
      addTimeline(
        store,
        sessionId,
        runId,
        'skill',
        'skill_read',
        loadedSkills.map((skill) => skill.name).join(', '),
        'done',
      )
    }

    let loadedTools: LoadedTool[] = []
    loadedTools = await ensureToolLoaded(store, sessionId, runId, loadedTools, 'delegate_agent', signal)

    if (loadedSkills.length) {
      loadedTools = await ensureToolLoaded(store, sessionId, runId, loadedTools, 'skill_search', signal)
      loadedTools = await ensureToolLoaded(store, sessionId, runId, loadedTools, 'skill_read', signal)
    }

    const context: AgentContext = {
      sessionId,
      runId,
      input,
      answerContext,
      loadedSkills,
      loadedTools,
    }

    const workerPromises = plan.tasks.map(async (task) => {
      const eventId = addTimeline(
        store,
        sessionId,
        runId,
        'agent',
        task.agentId,
        task.instruction,
        'running',
        task.agentId,
      )

      const artifact = await runWorkerTask(task, context, signal)
      updateTimelineEvent(store, sessionId, eventId, {
        detail: artifact.summary,
        status: 'done',
      })
      return artifact
    })

    const artifacts = await Promise.all(workerPromises)
    const deputyEventId = addTimeline(
      store,
      sessionId,
      runId,
      'agent',
      'DeputyArchitectAgent',
      'Merging worker artifacts.',
      'running',
      'deputy-architect',
    )

    await wait(160, signal)
    const merged = mergeArtifacts(artifacts)
    updateTimelineEvent(store, sessionId, deputyEventId, {
      detail: merged.summary,
      status: 'done',
    })

    const modelAdapter = createModelAdapter()
    // M1.3: construct the conversation context once, before the multi-turn loop.
    // MF3: pass the boundary straight through — when it is undefined the builder
    // conservatively injects nothing (never falls back to the current messages
    // length, which would塞 current-run / "已补充" messages into history).
    const conversationContext = buildConversationContext(
      store.getter(messagesBySessionAtom)[sessionId] ?? [],
      getConversationMemory(store, sessionId),
      historyEndIndex,
    )
    const agentTurn = await resolveAgentTurn({
      store,
      sessionId,
      runId,
      input,
      answerContext,
      artifacts,
      loadedTools,
      loadedSkills,
      modelAdapter,
      deterministicAnswer: merged.answer,
      conversationContext,
      signal,
    })
    loadedTools = agentTurn.loadedTools

    // RF2: the session may have been deleted while the model turn ran. Bail out
    // before any write-back so we never resurrect a removed session.
    if (!sessionExists(store, sessionId)) return
    // MF6: a newer run may have superseded this one while the model turn ran —
    // never write its result over the new run's state.
    if (!isCurrentRun(store, sessionId, runId)) return

    if (agentTurn.question) {
      addTimeline(
        store,
        sessionId,
        runId,
        'question',
        'AskUserQuestion',
        agentTurn.question.title ?? 'Waiting for user input.',
        'done',
      )

      appendMessage(store, sessionId, {
        id: createId('msg'),
        role: 'assistant',
        content: formatAskUserAssistantMessage(agentTurn.question),
        createdAt: Date.now(),
        // MF7: structural marker so this AskUser placeholder is excluded from
        // history by marker, never by its content prefix.
        scaffold: 'ask-placeholder',
      })

      patchRunState(store, sessionId, {
        status: 'waiting_user',
        pendingQuestion: agentTurn.question,
        loadedTools: loadedTools.map((tool) => tool.name),
      })
      return
    }

    await streamAssistantAnswer(store, sessionId, agentTurn.answer, signal)
    if (!isCurrentRun(store, sessionId, runId)) return
    patchRunState(store, sessionId, { status: 'done' })
  } catch (error) {
    // RF2: never write back to a session that was deleted mid-run.
    if (!sessionExists(store, sessionId)) return
    // MF6: a superseded run must not stomp the new run's state. In particular the
    // AbortError path below (start-while-running / stop-then-resend aborts the
    // old controller) would otherwise patch the *current* run to 'stopped'.
    if (!isCurrentRun(store, sessionId, runId)) return

    if (isAbortError(error)) {
      patchRunState(store, sessionId, { status: 'stopped' })
      return
    }

    const message = error instanceof Error ? error.message : String(error)
    patchRunState(store, sessionId, {
      status: 'error',
      error: message,
    })
    appendMessage(store, sessionId, {
      id: createId('msg'),
      role: 'assistant',
      content: `运行失败：${message}`,
      createdAt: Date.now(),
    })
  } finally {
    if (activeControllers.get(sessionId) === controller) {
      activeControllers.delete(sessionId)
    }
  }
}

async function resolveAgentTurn({
  store,
  sessionId,
  runId,
  input,
  answerContext,
  artifacts,
  loadedTools,
  loadedSkills,
  modelAdapter,
  deterministicAnswer,
  conversationContext,
  signal,
}: {
  store: Store
  sessionId: string
  runId: string
  input: string
  answerContext: AskUserAnswers | undefined
  artifacts: AgentArtifact[]
  loadedTools: LoadedTool[]
  loadedSkills: LoadedSkill[]
  modelAdapter: ModelAdapter
  deterministicAnswer: string
  conversationContext?: ConversationContext
  signal: AbortSignal
}): Promise<{ loadedTools: LoadedTool[]; question?: AskUserQuestionPayload; answer: string }> {
  let runtimeLoadedTools = loadedTools
  let modelVisibleTools: LoadedTool[] = []
  let continuation: AgentTurnContinuation | undefined
  let toolResult: AgentTurnToolResult | undefined
  let toolResults: AgentTurnToolResult[] | undefined
  let answeredAskUserBlocks = 0
  const loadedSkillNames = loadedSkills.map((skill) => skill.name)

  for (let turnIndex = 0; turnIndex < MAX_AGENT_TURNS; turnIndex += 1) {
    const decision = await runAgentTurn(
      store,
      sessionId,
      runId,
      `Agent loop turn ${turnIndex + 1}: ${modelVisibleTools.length ? 'loaded tool schemas available.' : 'manifest only.'}`,
      modelAdapter,
      {
        userInput: input,
        answerContext,
        availableTools: listToolSummaries(),
        loadedTools: modelVisibleTools,
        loadedSkills: loadedSkillNames,
        artifacts,
        deterministicAnswer,
        continuation,
        toolResult,
        toolResults,
        // MF2 (§0 / Rm9): inject conversation history ONLY into the very first
        // model turn. Later turns must not re-inject — and `continuation` is an
        // unreliable signal because some turns (mock paths / DeepSeek JSON
        // fallback) carry no continuation yet still re-enter the loop. Keying on
        // turnIndex===0 closes that hole; on the first turn the history enters
        // state.messages and continuation turns reuse it from there.
        conversationContext: turnIndex === 0 ? conversationContext : undefined,
        signal,
      },
    )

    if (decision.type === 'assistant_message') {
      return { loadedTools: runtimeLoadedTools, answer: decision.content }
    }

    if (decision.type === 'tool_request') {
      if (decision.toolName === 'ask_user_question' && hasAnswerContext(answerContext)) {
        answeredAskUserBlocks += 1
        addTimeline(
          store,
          sessionId,
          runId,
          'system',
          'AskUserQuestion skipped',
          'User answers already exist for this resumed run; continuing instead of pausing again.',
          'done',
        )
        if (!decision.continuation || answeredAskUserBlocks >= 2) {
          return { loadedTools: runtimeLoadedTools, answer: deterministicAnswer }
        }
        continuation = decision.continuation
        toolResult = {
          toolName: 'ask_user_question',
          toolCallId: decision.toolCallId,
          content: formatAskUserAlreadyAnsweredResult(answerContext),
        }
        toolResults = [toolResult]
        continue
      }

      runtimeLoadedTools = await ensureToolLoaded(store, sessionId, runId, runtimeLoadedTools, decision.toolName, signal)
      const requestedTool = runtimeLoadedTools.find((tool) => tool.name === decision.toolName)
      continuation = decision.continuation
      toolResult = requestedTool
        ? {
            toolName: requestedTool.name,
            toolCallId: decision.toolCallId,
            content: formatLoadedToolResult(requestedTool),
          }
        : {
            toolName: decision.toolName,
            toolCallId: decision.toolCallId,
            content: formatRuntimeToolError(`Tool not found: ${decision.toolName}`),
          }
      toolResults = [toolResult]
      if (requestedTool) modelVisibleTools = appendVisibleTool(modelVisibleTools, requestedTool)
      continue
    }

    if (decision.type === 'tool_requests') {
      const results: AgentTurnToolResult[] = []
      for (const request of decision.requests) {
        if (request.toolName === 'ask_user_question' && hasAnswerContext(answerContext)) {
          answeredAskUserBlocks += 1
          addTimeline(
            store,
            sessionId,
            runId,
            'system',
            'AskUserQuestion skipped',
            'User answers already exist for this resumed run; continuing instead of pausing again.',
            'done',
          )
          results.push({
            toolName: request.toolName,
            toolCallId: request.toolCallId,
            content: formatAskUserAlreadyAnsweredResult(answerContext),
          })
          continue
        }

        runtimeLoadedTools = await ensureToolLoaded(store, sessionId, runId, runtimeLoadedTools, request.toolName, signal)
        const requestedTool = runtimeLoadedTools.find((tool) => tool.name === request.toolName)
        if (requestedTool) modelVisibleTools = appendVisibleTool(modelVisibleTools, requestedTool)
        results.push(
          requestedTool
            ? {
                toolName: requestedTool.name,
                toolCallId: request.toolCallId,
                content: formatLoadedToolResult(requestedTool),
              }
            : {
                toolName: request.toolName,
                toolCallId: request.toolCallId,
                content: formatRuntimeToolError(`Tool not found: ${request.toolName}`),
              },
        )
      }

      if (!results.length || answeredAskUserBlocks >= 2) {
        return { loadedTools: runtimeLoadedTools, answer: deterministicAnswer }
      }

      continuation = decision.continuation
      toolResults = results
      toolResult = results[0]
      continue
    }

    if (decision.type === 'tool_payloads') {
      const results: AgentTurnToolResult[] = []
      for (const call of decision.calls) {
        if (call.toolName === 'ask_user_question') {
          if (hasAnswerContext(answerContext)) {
            answeredAskUserBlocks += 1
            addTimeline(
              store,
              sessionId,
              runId,
              'system',
              'AskUserQuestion skipped',
              'User answers already exist for this resumed run; continuing instead of pausing again.',
              'done',
            )
            results.push({
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              content: formatAskUserAlreadyAnsweredResult(answerContext),
            })
            continue
          }

          const question = normalizeAskUserQuestionPayload(call.payload)
          if (question) {
            runtimeLoadedTools = await ensureToolLoaded(store, sessionId, runId, runtimeLoadedTools, 'browser_action', signal)
            return {
              loadedTools: runtimeLoadedTools,
              question,
              answer: deterministicAnswer,
            }
          }

          results.push({
            toolName: call.toolName,
            toolCallId: call.toolCallId,
            content: formatRuntimeToolError('Invalid ask_user_question payload.'),
          })
          continue
        }

        results.push(
          await executeRuntimeToolCall({
            store,
            sessionId,
            runId,
            toolName: call.toolName,
            payload: call.payload,
            toolCallId: call.toolCallId,
            context: {
              sessionId,
              runId,
              input,
              answerContext,
              loadedSkills,
              loadedTools: runtimeLoadedTools,
            },
            signal,
          }),
        )
      }

      if (!results.length || answeredAskUserBlocks >= 2) {
        return { loadedTools: runtimeLoadedTools, answer: deterministicAnswer }
      }

      continuation = decision.continuation
      toolResults = results
      toolResult = results[0]
      continue
    }

    if (!modelVisibleTools.some((tool) => tool.name === decision.toolName)) {
      runtimeLoadedTools = await ensureToolLoaded(store, sessionId, runId, runtimeLoadedTools, decision.toolName, signal)
      const requestedTool = runtimeLoadedTools.find((tool) => tool.name === decision.toolName)
      continuation = decision.continuation
      toolResult = requestedTool
        ? {
            toolName: requestedTool.name,
            toolCallId: decision.toolCallId,
            content: formatLoadedToolResult(requestedTool),
          }
        : {
            toolName: decision.toolName,
            toolCallId: decision.toolCallId,
            content: formatRuntimeToolError(`Tool not found: ${decision.toolName}`),
          }
      toolResults = [toolResult]
      if (requestedTool) modelVisibleTools = appendVisibleTool(modelVisibleTools, requestedTool)
      continue
    }

    if (decision.toolName === 'ask_user_question') {
      if (hasAnswerContext(answerContext)) {
        answeredAskUserBlocks += 1
        addTimeline(
          store,
          sessionId,
          runId,
          'system',
          'AskUserQuestion skipped',
          'User answers already exist for this resumed run; continuing instead of pausing again.',
          'done',
        )
        if (!decision.continuation || answeredAskUserBlocks >= 2) {
          return { loadedTools: runtimeLoadedTools, answer: deterministicAnswer }
        }
        continuation = decision.continuation
        toolResult = {
          toolName: decision.toolName,
          toolCallId: decision.toolCallId,
          content: formatAskUserAlreadyAnsweredResult(answerContext),
        }
        toolResults = [toolResult]
        continue
      }

      const question = normalizeAskUserQuestionPayload(decision.payload)
      if (!question) {
        continuation = decision.continuation
        toolResult = {
          toolName: decision.toolName,
          toolCallId: decision.toolCallId,
          content: formatRuntimeToolError('Invalid ask_user_question payload.'),
        }
        toolResults = [toolResult]
        continue
      }

      runtimeLoadedTools = await ensureToolLoaded(store, sessionId, runId, runtimeLoadedTools, 'browser_action', signal)
      return {
        loadedTools: runtimeLoadedTools,
        question,
        answer: deterministicAnswer,
      }
    }

    continuation = decision.continuation
    toolResult = await executeRuntimeToolCall({
      store,
      sessionId,
      runId,
      toolName: decision.toolName,
      payload: decision.payload,
      toolCallId: decision.toolCallId,
      context: {
        sessionId,
        runId,
        input,
        answerContext,
        loadedSkills,
        loadedTools: runtimeLoadedTools,
      },
      signal,
    })
    toolResults = [toolResult]
  }

  addTimeline(
    store,
    sessionId,
    runId,
    'system',
    'Agent loop limit reached',
    `Stopped after ${MAX_AGENT_TURNS} model/tool turns.`,
    'error',
  )
  return { loadedTools: runtimeLoadedTools, answer: deterministicAnswer }
}

function formatLoadedToolResult(tool: LoadedTool) {
  return JSON.stringify({
    toolName: tool.name,
    description: tool.description,
    runtime: tool.runtime,
    inputSchema: tool.inputSchema,
  })
}

function formatAskUserAssistantMessage(question: AskUserQuestionPayload) {
  const title = question.title ? `：${question.title}` : ''
  return `${ASK_USER_PLACEHOLDER_PREFIX}${title}（${question.questions.length} 个问题）。`
}

function hasAnswerContext(answerContext: AskUserAnswers | undefined) {
  return Boolean(answerContext && Object.keys(answerContext).length)
}

function formatAskUserAlreadyAnsweredResult(answerContext: AskUserAnswers | undefined) {
  return JSON.stringify({
    accepted: false,
    code: 'user_answers_already_provided',
    message: 'The user already answered the pending questions for this resumed run. Continue with answerContext instead of pausing again.',
    answerContext: answerContext ?? {},
  })
}

function appendVisibleTool(currentTools: LoadedTool[], nextTool: LoadedTool) {
  if (currentTools.some((tool) => tool.name === nextTool.name)) return currentTools
  return [...currentTools, nextTool]
}

async function executeRuntimeToolCall({
  store,
  sessionId,
  runId,
  toolName,
  payload,
  toolCallId,
  context,
  signal,
}: {
  store: Store
  sessionId: string
  runId: string
  toolName: string
  payload: unknown
  toolCallId?: string
  context: AgentContext
  signal: AbortSignal
}): Promise<AgentTurnToolResult> {
  const eventId = addTimeline(store, sessionId, runId, 'tool', `call ${toolName}`, formatToolPayloadPreview(payload), 'running')

  try {
    const content = await runRuntimeTool(store, toolName, payload, context, signal)
    updateTimelineEvent(store, sessionId, eventId, {
      detail: formatToolResultPreview(content),
      status: 'done',
    })
    return { toolName, toolCallId, content }
  } catch (error) {
    if (isAbortError(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    const content = formatRuntimeToolError(message)
    updateTimelineEvent(store, sessionId, eventId, {
      detail: message,
      status: 'error',
    })
    return { toolName, toolCallId, content }
  }
}

async function runRuntimeTool(
  store: Store,
  toolName: string,
  payload: unknown,
  context: AgentContext,
  signal: AbortSignal,
): Promise<string> {
  const args = asRecord(payload)

  if (toolName === 'skill_search') {
    const query = typeof args.query === 'string' ? args.query : ''
    return JSON.stringify({
      query,
      results: searchSkills(query),
    })
  }

  if (toolName === 'skill_read') {
    const name = typeof args.name === 'string' ? args.name : ''
    const skill = readSkill(name)
    return JSON.stringify(
      skill
        ? {
            name,
            skill,
          }
        : {
            name,
            error: 'Skill not found.',
          },
    )
  }

  if (toolName === 'delegate_agent') {
    const agentId = typeof args.agentId === 'string' && isWorkerAgentId(args.agentId) ? args.agentId : undefined
    const instruction = typeof args.instruction === 'string' ? args.instruction : ''
    if (!agentId || !instruction.trim()) {
      return formatRuntimeToolError('Invalid delegate_agent payload.')
    }

    const artifact = await runWorkerTask(
      {
        id: createId('task'),
        agentId,
        instruction,
      },
      context,
      signal,
    )
    return JSON.stringify({ artifact })
  }

  if (toolName === 'save_file') {
    // P2.1 / §1.5: the tool runs synchronously, never opens a picker, and never
    // pauses the loop. It only stages the artifact (per-session) so the save UI
    // can land it on disk inside a real user gesture, then returns a readiness
    // result JSON that is fed back to the model (§1.12 — no assistant message).
    // PF5: an empty file (content === '') is legitimate. Require only a
    // non-empty filename and that content is a string.
    const filename = typeof args.filename === 'string' ? args.filename.trim() : ''
    const hasStringContent = typeof args.content === 'string'
    const content = hasStringContent ? (args.content as string) : ''
    const mimeType = typeof args.mimeType === 'string' && args.mimeType.trim() ? args.mimeType.trim() : undefined
    if (!filename || !hasStringContent) {
      return formatRuntimeToolError('Invalid save_file payload: filename (non-empty) and string content are required.')
    }

    const artifactId = addPendingArtifact(store, context.sessionId, { filename, content, mimeType })
    return JSON.stringify({
      accepted: true,
      message: '内容已就绪，已在界面提供保存按钮，待用户手势确认后写入本地文件。',
      filename,
      bytes: byteLength(content),
      artifactId,
    })
  }

  if (toolName === 'browser_action') {
    const action = typeof args.action === 'string' ? args.action : undefined
    return JSON.stringify({
      accepted: Boolean(action),
      action,
      payload: args.payload ?? null,
    })
  }

  return formatRuntimeToolError(`Unsupported runtime tool: ${toolName}`)
}

function normalizeAskUserQuestionPayload(payload: unknown): AskUserQuestionPayload | undefined {
  const value = asRecord(payload)
  if (typeof value.id !== 'string' || !Array.isArray(value.questions)) return undefined

  const questions = value.questions
    .map((question) => {
      const item = asRecord(question)
      if (typeof item.id !== 'string' || typeof item.text !== 'string' || typeof item.type !== 'string') return undefined
      if (!isQuestionType(item.type)) return undefined
      const nextQuestion: AskUserQuestionItem = {
        id: item.id,
        text: item.text,
        type: item.type,
      }
      if (Array.isArray(item.options)) {
        nextQuestion.options = item.options.filter((option): option is string => typeof option === 'string')
      }
      if (typeof item.required === 'boolean') {
        nextQuestion.required = item.required
      }
      return nextQuestion
    })
    .filter((question): question is AskUserQuestionPayload['questions'][number] => Boolean(question))

  if (!questions.length) return undefined

  return {
    id: value.id,
    title: typeof value.title === 'string' ? value.title : undefined,
    questions,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function isWorkerAgentId(value: string): value is WorkerAgentId {
  return ['skill-worker', 'tool-worker', 'answer-worker', 'clarifier-worker'].includes(value)
}

function isQuestionType(value: string): value is AskUserQuestionItem['type'] {
  return ['text', 'single-choice', 'multi-choice', 'confirm'].includes(value)
}

function formatRuntimeToolError(message: string) {
  return JSON.stringify({ error: message })
}

function byteLength(value: string) {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length
  return value.length
}

function formatToolPayloadPreview(payload: unknown) {
  return `payload ${formatToolResultPreview(JSON.stringify(payload ?? {}))}`
}

function formatToolResultPreview(content: string) {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 120) return normalized
  return `${normalized.slice(0, 120)}...`
}

async function runAgentTurn(
  store: Store,
  sessionId: string,
  runId: string,
  detail: string,
  modelAdapter: ModelAdapter,
  input: Parameters<ModelAdapter['runAgentTurn']>[0],
): Promise<AgentTurnResult> {
  const eventId = addTimeline(store, sessionId, runId, 'model', 'ModelAgentTurn', detail, 'running')
  const streamProgress = createModelStreamProgress()
  const decision = await modelAdapter.runAgentTurn({
    ...input,
    onStreamEvent: (event) => {
      input.onStreamEvent?.(event)
      const nextDetail = streamProgress(event)
      if (nextDetail) {
        updateTimelineEvent(store, sessionId, eventId, { detail: nextDetail })
      }
    },
  })
  updateTimelineEvent(store, sessionId, eventId, {
    detail: describeAgentTurnResult(decision),
    status: 'done',
  })
  return decision
}

function createModelStreamProgress(): (event: ModelStreamEvent) => string | undefined {
  let reasoning = ''
  let content = ''
  let toolName = ''
  let lastDetail = ''
  let lastUpdateAt = 0

  return (event) => {
    if (event.type === 'reasoning') {
      reasoning += event.content
    } else if (event.type === 'content') {
      content += event.content
    } else {
      toolName = event.name || toolName
    }

    const now = Date.now()
    const shouldThrottle = event.type !== 'tool_call' && now - lastUpdateAt < 120
    if (shouldThrottle) return undefined
    lastUpdateAt = now

    const nextDetail = formatModelStreamProgress({
      event,
      reasoning,
      content,
      toolName,
    })
    if (!nextDetail || nextDetail === lastDetail) return undefined
    lastDetail = nextDetail
    return nextDetail
  }
}

function formatModelStreamProgress({
  event,
  reasoning,
  content,
  toolName,
}: {
  event: ModelStreamEvent
  reasoning: string
  content: string
  toolName: string
}) {
  if (event.type === 'tool_call') {
    return `工具调用：${toolName || '生成中'}${event.arguments ? ' · 参数生成中' : ''}`
  }
  if (content.trim()) return `回复草稿：${clipProgressText(content)}`
  if (reasoning.trim()) return `思考：${clipProgressText(reasoning)}`
  return undefined
}

function clipProgressText(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 96) return normalized
  return `${normalized.slice(-96)}`
}

function describeAgentTurnResult(decision: AgentTurnResult) {
  if (decision.type === 'assistant_message') {
    return decision.error ? `${decision.source}: ${decision.error}` : `${decision.source} assistant message`
  }
  if (decision.type === 'tool_request') return `request ${decision.toolName}: ${decision.reason}`
  if (decision.type === 'tool_requests') {
    return `request ${decision.requests.map((request) => request.toolName).join(', ')}: ${decision.requests
      .map((request) => request.reason)
      .join(' | ')}`
  }
  if (decision.type === 'tool_payloads') {
    return `payload ${decision.calls.map((call) => call.toolName).join(', ')}`
  }
  const question = normalizeAskUserQuestionPayload(decision.payload)
  if (decision.toolName === 'ask_user_question' && question) {
    return `payload ${decision.toolName}: ${question.questions.length} question(s)`
  }
  return `payload ${decision.toolName}`
}

async function ensureToolLoaded(
  store: Store,
  sessionId: string,
  runId: string,
  currentTools: LoadedTool[],
  toolName: string,
  signal: AbortSignal,
): Promise<LoadedTool[]> {
  if (currentTools.some((tool) => tool.name === toolName)) return currentTools

  const eventId = addTimeline(store, sessionId, runId, 'tool', `load ${toolName}`, 'Loading schema.', 'running')
  await wait(120, signal)
  const tool = loadTool(toolName)
  if (!tool) {
    updateTimelineEvent(store, sessionId, eventId, {
      detail: 'Tool not found.',
      status: 'error',
    })
    return currentTools
  }

  const nextTools = [...currentTools, tool]
  patchRunState(store, sessionId, {
    loadedTools: nextTools.map((loadedTool) => loadedTool.name),
  })
  updateTimelineEvent(store, sessionId, eventId, {
    detail: `${tool.runtime} schema loaded.`,
    status: 'done',
  })

  return nextTools
}

async function streamAssistantAnswer(store: Store, sessionId: string, answer: string, signal: AbortSignal) {
  const message: ChatMessage = {
    id: createId('msg'),
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
    streaming: true,
  }

  appendMessage(store, sessionId, message)

  let content = ''

  for (let index = 0; index < answer.length; index += 8) {
    const chunk = answer.slice(index, index + 8)
    await wait(18, signal)
    // RF2: stop streaming into a session that was deleted mid-run.
    if (!sessionExists(store, sessionId)) return
    content += chunk
    updateMessage(store, sessionId, message.id, { content })
  }

  updateMessage(store, sessionId, message.id, {
    content,
    streaming: false,
  })
}

function addTimeline(
  store: Store,
  sessionId: string,
  runId: string,
  kind: TimelineKind,
  title: string,
  detail: string | undefined,
  status: TimelineEvent['status'],
  actor?: string,
) {
  const eventId = createId('event')
  appendTimelineEvent(store, sessionId, {
    id: eventId,
    runId,
    kind,
    title,
    detail,
    actor,
    status,
    timestamp: Date.now(),
  })
  return eventId
}

function abortSessionRun(sessionId: string) {
  activeControllers.get(sessionId)?.abort()
  activeControllers.delete(sessionId)
}

/**
 * RF2: a deleted session must never be resurrected by a late write-back from an
 * in-flight run. If the session no longer exists, callers bail out silently.
 */
function sessionExists(store: Store, sessionId: string) {
  return Boolean(store.getter(sessionsAtom)[sessionId])
}

/**
 * MF6: a session can only host one run at a time. When a new run is started
 * (start-while-running) or a stopped run is resent, the old run keeps executing
 * (or its aborted awaits reject) and may try to write back — e.g. the abort
 * catch does `patchRunState(status:'stopped')`, which is keyed only by
 * sessionId and would stomp the *new* run. Gate every terminal write-back on the
 * current run still being this run.
 */
function isCurrentRun(store: Store, sessionId: string, runId: string) {
  return store.getter(runsBySessionAtom)[sessionId]?.id === runId
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function formatUserAnswers(answers: AskUserAnswers) {
  const lines = Object.entries(answers).map(([key, value]) => {
    if (Array.isArray(value)) return `- ${key}: ${value.join(', ')}`
    return `- ${key}: ${String(value)}`
  })

  return [USER_ANSWERS_ECHO_PREFIX, ...lines].join('\n')
}
