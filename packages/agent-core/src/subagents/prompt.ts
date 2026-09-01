import { buildCustomInstructionsItem } from '../runtime/modelTurn'
import { ROOT_AGENT_PATH } from './path'
import type {
  DelegateAgentChildSpec,
  SubagentNodeRecord,
  SubagentSkillFile,
  SubagentToolProfile,
} from './types'

const SKILL_CONTEXT_LIMIT = 18_000

export interface ChildSystemPromptArgs {
  node: SubagentNodeRecord
  spec: DelegateAgentChildSpec
  inheritedSkills: SubagentSkillFile[]
  localSkill: SubagentSkillFile
  toolProfile: SubagentToolProfile
  confirmedTools: readonly string[]
  customInstructions?: string
  environment?: string
}

function renderSkillsForPrompt(skills: SubagentSkillFile[]): string {
  const body = skills
    .map((skill) => [`# ${skill.filename}`, skill.content.trim()].join('\n\n'))
    .join('\n\n---\n\n')
  return body.length > SKILL_CONTEXT_LIMIT ? `${body.slice(0, SKILL_CONTEXT_LIMIT)}\n...[truncated]` : body
}

function childToolProfilePromptLines(toolProfile: SubagentToolProfile): string[] {
  if (toolProfile === 'workspace_verify') {
    return [
      '允许 delegate_agent、本机 agent 历史只读工具、只读文件工具（路径权限继承会话授权模式），以及验证工具 run_verification_command；不得写文件。',
      'run_verification_command 可执行验收所需的 shell 命令及项目脚本。它的输出就是你的执行证据：用真实退出码与输出下判断，不要凭推测断言测试通过或失败。',
    ]
  }
  return [
    toolProfile === 'workspace_read'
      ? '允许 delegate_agent、本机 agent 历史只读工具和只读文件工具（路径权限继承会话授权模式）；不得声称或尝试写文件、执行 shell。'
      : '只允许 delegate_agent 和本机 agent 历史只读工具；不要模拟工具调用，不要声称已经改文件。',
  ]
}

export function buildChildSystemPrompt(args: ChildSystemPromptArgs): string {
  const skills = renderSkillsForPrompt([...args.inheritedSkills, args.localSkill])
  const customInstructions = buildCustomInstructionsItem(args.customInstructions ?? '')
  const environment = args.environment?.trim()
  return [
    `你是树形子 agent ${args.node.path}。`,
    `父 agent: ${args.node.parentPath ?? ROOT_AGENT_PATH}`,
    '你在 headless 子 agent 运行时中工作：不要要求 UI 暂停；需要更多并行分析时，可以调用 delegate_agent 派生下一层子 agent。',
    ...childToolProfilePromptLines(args.toolProfile),
    args.confirmedTools.length > 0
      ? `本次委派另有父级已确认、仅限本 run 的危险工具能力: ${args.confirmedTools.join(', ')}。不得请求其它危险工具，也不得向后代扩大范围。`
      : '没有危险工具能力；不得请求写文件、patch 或 shell。',
    args.spec.mode === 'evaluator'
      ? '你是验收评估器。最终输出必须严格遵循任务中的期望输出；要求 JSON 时只能输出 JSON，不要 Markdown、代码围栏或额外说明。'
      : '最终输出必须是可回填给父 agent 的简洁 Markdown：结论、发现、风险、建议下一步。',
    ...(environment ? ['', environment] : []),
    ...(customInstructions ? ['', customInstructions.content] : []),
    '',
    '继承的临时 skills:',
    skills,
  ].join('\n')
}

export function buildChildUserPrompt(spec: DelegateAgentChildSpec): string {
  return [
    `任务目标: ${spec.objective}`,
    spec.mode ? `模式: ${spec.mode}` : '',
    spec.expectedOutput ? `期望输出: ${spec.expectedOutput}` : '',
    '',
    '请完成任务；如果需要拆分并行工作，调用 delegate_agent。',
  ]
    .filter(Boolean)
    .join('\n')
}
