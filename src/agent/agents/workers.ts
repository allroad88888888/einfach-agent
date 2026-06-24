import type {
  AgentArtifact,
  AgentContext,
  LoadedSkill,
  LoadedTool,
  WorkerTask,
} from '../runtime/types'

const delay = (ms: number, signal?: AbortSignal) =>
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

export async function runWorkerTask(
  task: WorkerTask,
  context: AgentContext,
  signal?: AbortSignal,
): Promise<AgentArtifact> {
  await delay(220, signal)

  switch (task.agentId) {
    case 'skill-worker':
      return runSkillWorker(context.loadedSkills)
    case 'tool-worker':
      return runToolWorker(context.loadedTools)
    case 'clarifier-worker':
      return runClarifierWorker(context)
    case 'answer-worker':
      return runAnswerWorker(context)
    default:
      return {
        agentId: task.agentId,
        summary: 'No worker implementation matched this task.',
        confidence: 0.2,
      }
  }
}

function runSkillWorker(loadedSkills: LoadedSkill[]): AgentArtifact {
  return {
    agentId: 'skill-worker',
    summary: loadedSkills.length
      ? `Loaded skills: ${loadedSkills.map((skill) => skill.name).join(', ')}.`
      : 'No repository skills matched this run.',
    findings: loadedSkills.map((skill) => skill.description),
    confidence: loadedSkills.length ? 0.88 : 0.55,
  }
}

function runToolWorker(loadedTools: LoadedTool[]): AgentArtifact {
  return {
    agentId: 'tool-worker',
    summary: loadedTools.length
      ? `Loaded tools: ${loadedTools.map((tool) => tool.name).join(', ')}.`
      : 'No tool schemas have been loaded yet.',
    findings: loadedTools.map((tool) => `${tool.name} runs in ${tool.runtime}.`),
    confidence: 0.82,
  }
}

function runClarifierWorker(context: AgentContext): AgentArtifact {
  if (context.answerContext) {
    return {
      agentId: 'clarifier-worker',
      summary: 'The user already answered the pending question.',
      confidence: 0.92,
    }
  }

  const shouldClarify = shouldConsiderClarification(context.input)

  return {
    agentId: 'clarifier-worker',
    summary: shouldClarify
      ? 'The request may need user clarification; model tool planning must decide whether to ask.'
      : 'No blocking clarification is required.',
    findings: shouldClarify ? ['Clarification candidate: ask_user_question may be useful.'] : undefined,
    confidence: shouldClarify ? 0.72 : 0.78,
  }
}

function runAnswerWorker(context: AgentContext): AgentArtifact {
  const skillNames = context.loadedSkills.map((skill) => skill.name)
  const toolNames = context.loadedTools.map((tool) => tool.name)
  const answerContext = context.answerContext

  if (isGreeting(context.input)) {
    return {
      agentId: 'answer-worker',
      summary: 'Drafted a direct greeting response.',
      proposedAnswer: 'Hi，可以帮你规划、拆解或执行这个 Web Agent 的任务。你可以直接描述要做什么。',
      confidence: 0.9,
    }
  }

  const answer = [
    '### 运行结果',
    '',
    '已根据当前输入、已加载 skills 和 lazy tools 生成本轮结果。',
    '',
    '### 当前实现边界',
    '',
    '- 不读取项目文件，不执行终端，不接真实外部工具。',
    '- Skills 来自代码仓库，按触发词读取完整内容。',
    '- Tools 先只暴露摘要，需要时才加载 schema。',
    '- AskUserQuestion 是 runtime 内建暂停动作，不依赖插件能力。',
    '- 状态由 `@einfach/core` / `@einfach/react` 承载。',
    '',
    answerContext ? `### 用户补充\n\n${formatAnswers(answerContext)}\n` : '',
    '### 本轮上下文',
    '',
    `- Loaded skills: ${skillNames.join(', ') || 'none'}`,
    `- Loaded tools: ${toolNames.join(', ') || 'none'}`,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    agentId: 'answer-worker',
    summary: 'Drafted the final chat response.',
    proposedAnswer: answer,
    confidence: 0.84,
  }
}

function shouldConsiderClarification(input: string) {
  const normalizedInput = input.trim()
  return normalizedInput.length > 0 && !isGreeting(normalizedInput) && /问我|需要确认|不确定|随便|帮我做一下|优化一下/.test(normalizedInput)
}

function isGreeting(input: string) {
  return /^(hi|hello|hey|你好|您好|嗨|哈喽|hello[!.。！]?|hi[!.。！]?)$/i.test(input.trim())
}

function formatAnswers(answers: Record<string, unknown>): string {
  return Object.entries(answers)
    .map(([key, value]) => `- ${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
    .join('\n')
}
