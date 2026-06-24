import type {
  AgentTurnInput,
  AgentTurnResult,
  GenerateFinalAnswerInput,
  ModelAdapter,
  ModelAnswer,
} from './types'

export class MockModelAdapter implements ModelAdapter {
  readonly kind = 'mock'

  async runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (shouldExerciseDelayedAskUserLoop(input.userInput)) {
      return runDelayedAskUserLoop(input)
    }

    if (shouldExerciseBatchSchemaLoop(input.userInput) && !input.toolResult && !input.toolResults?.length) {
      return {
        type: 'tool_requests',
        requests: [
          {
            toolName: 'skill_search',
            reason: 'Need skill_search schema before searching skills.',
            toolCallId: 'mock-call-skill-search',
          },
          {
            toolName: 'skill_read',
            reason: 'Need skill_read schema before reading skills.',
            toolCallId: 'mock-call-skill-read',
          },
        ],
      }
    }

    if (shouldExerciseToolLoop(input.userInput)) {
      return runMultiToolLoop(input)
    }

    if (input.answerContext || !shouldAskUser(input.userInput)) {
      return {
        type: 'assistant_message',
        source: 'mock',
        content: input.deterministicAnswer,
      }
    }

    const askUserToolLoaded = input.loadedTools.some((tool) => tool.name === 'ask_user_question')
    if (!askUserToolLoaded) {
      return {
        type: 'tool_request',
        toolName: 'ask_user_question',
        reason: 'The request is ambiguous and needs user decisions.',
      }
    }

    return {
      type: 'tool_payload',
      toolName: 'ask_user_question',
      payload: {
        id: `question-${Date.now()}`,
        title: '需要确认',
        questions: [
          {
            id: 'execution_scope',
            text: '这次希望 agent 直接给方案，还是先拆成模块任务？',
            type: 'single-choice',
            options: ['直接给方案', '先拆模块', '只提关键风险'],
            required: true,
          },
          {
            id: 'extra_context',
            text: '还有必须遵守的边界吗？',
            type: 'text',
          },
          {
            id: 'focus_modules',
            text: '这次重点看哪些模块？',
            type: 'multi-choice',
            options: ['runtime', 'tools', 'skills', 'ui'],
            required: true,
          },
          {
            id: 'allow_assumptions',
            text: '信息不足时是否允许采用保守默认值？',
            type: 'confirm',
            required: true,
          },
        ],
      },
    }
  }

  async generateFinalAnswer(input: GenerateFinalAnswerInput): Promise<ModelAnswer> {
    return {
      source: 'mock',
      content: input.deterministicAnswer,
    }
  }
}

function runDelayedAskUserLoop(input: AgentTurnInput): AgentTurnResult {
  const searchToolLoaded = input.loadedTools.some((tool) => tool.name === 'skill_search')
  const readToolLoaded = input.loadedTools.some((tool) => tool.name === 'skill_read')
  const askUserToolLoaded = input.loadedTools.some((tool) => tool.name === 'ask_user_question')
  const result = input.toolResult

  if (!searchToolLoaded) {
    return {
      type: 'tool_request',
      toolName: 'skill_search',
      reason: 'Need skill_search schema before gathering context.',
    }
  }

  if (!result || isLoadedSchemaResult(result, 'skill_search')) {
    return {
      type: 'tool_payload',
      toolName: 'skill_search',
      payload: {
        query: 'ask user',
      },
    }
  }

  if (result.toolName === 'skill_search' && !readToolLoaded) {
    return {
      type: 'tool_request',
      toolName: 'skill_read',
      reason: 'Need skill_read schema before reading the selected context.',
    }
  }

  if (isLoadedSchemaResult(result, 'skill_read')) {
    return {
      type: 'tool_payload',
      toolName: 'skill_read',
      payload: {
        name: 'ask-user-question',
      },
    }
  }

  if (result.toolName === 'skill_read' && !askUserToolLoaded) {
    return {
      type: 'tool_request',
      toolName: 'ask_user_question',
      reason: 'Need ask_user_question schema after collecting context.',
    }
  }

  if (isLoadedSchemaResult(result, 'ask_user_question')) {
    return {
      type: 'tool_payload',
      toolName: 'ask_user_question',
      payload: {
        id: `delayed-question-${Date.now()}`,
        title: '延迟确认',
        questions: [
          {
            id: 'target_domain',
            text: '这些类型主要用于哪个业务域？',
            type: 'text',
            required: true,
          },
          {
            id: 'planning_depth',
            text: '希望规划到什么粒度？',
            type: 'single-choice',
            options: ['只列类型名', '包含字段说明', '包含接口/数据库映射'],
            required: true,
          },
        ],
      },
    }
  }

  return {
    type: 'assistant_message',
    source: 'mock',
    content: input.deterministicAnswer,
  }
}

function runMultiToolLoop(input: AgentTurnInput): AgentTurnResult {
  const searchToolLoaded = input.loadedTools.some((tool) => tool.name === 'skill_search')
  const readToolLoaded = input.loadedTools.some((tool) => tool.name === 'skill_read')
  const result = input.toolResult

  if (!searchToolLoaded) {
    return {
      type: 'tool_request',
      toolName: 'skill_search',
      reason: 'Need skill_search schema before searching skills.',
    }
  }

  if (!result || isLoadedSchemaResult(result, 'skill_search')) {
    return {
      type: 'tool_payload',
      toolName: 'skill_search',
      payload: {
        query: 'web agent',
      },
    }
  }

  if (isLoadedSchemaResult(result, 'skill_read')) {
    return {
      type: 'tool_payload',
      toolName: 'skill_read',
      payload: {
        name: 'web-chat-agent',
      },
    }
  }

  if (result.toolName === 'skill_read') {
    return {
      type: 'assistant_message',
      source: 'mock',
      content: `multi-turn complete\n${result.content}`,
    }
  }

  if (!readToolLoaded) {
    return {
      type: 'tool_request',
      toolName: 'skill_read',
      reason: 'Need skill_read schema before reading the selected skill.',
    }
  }

  if (result.toolName === 'skill_search') {
    return {
      type: 'tool_payload',
      toolName: 'skill_read',
      payload: {
        name: 'web-chat-agent',
      },
    }
  }

  return {
    type: 'tool_payload',
    toolName: 'skill_search',
    payload: {
      query: 'web agent',
    },
  }
}

function shouldExerciseToolLoop(input: string) {
  return /loop tools|多轮工具|连续工具/.test(input)
}

function shouldExerciseBatchSchemaLoop(input: string) {
  return /batch schema|批量schema|批量 schema/.test(input)
}

function shouldExerciseDelayedAskUserLoop(input: string) {
  return /delayed askuser|延迟问我|后面再问|多轮后问我/.test(input)
}

function isLoadedSchemaResult(result: AgentTurnInput['toolResult'], toolName: string) {
  return result?.toolName === toolName && result.content.includes('"inputSchema"')
}

function shouldAskUser(input: string) {
  const normalizedInput = input.trim().toLowerCase()
  if (!normalizedInput) return false
  if (/^(hi|hello|hey|你好|您好|嗨|哈喽|hello[!.。！]?|hi[!.。！]?)$/.test(normalizedInput)) return false
  return /问我|需要确认|不确定|随便|帮我做一下|优化一下/.test(input)
}
