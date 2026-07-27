import {
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_PRO_MODEL,
  type DeepSeekReasoningEffort,
  type ModelFunctionTool,
} from '@web-agent/ai'
import {
  routeSubagentModel,
  type SubagentRouteDecision,
  type SubagentRouteFeatures,
} from '@web-agent/core/subagents/routing'
import { ROOT_AGENT_PATH } from '@web-agent/core/subagents/path'

export const DEEPSEEK_TASK_SUITE_VERSION = '2026-07-24.3'
export const DEEPSEEK_TASK_RESULT_SCHEMA = 'deepseek-task-ab/v2'

export type DeepSeekTaskArm = 'pro' | 'flash'

export interface DeepSeekTaskLane {
  arm: DeepSeekTaskArm
  model: typeof DEEPSEEK_PRO_MODEL | typeof DEEPSEEK_FLASH_MODEL
}

export const DEEPSEEK_TASK_LANES: readonly DeepSeekTaskLane[] = [
  { arm: 'pro', model: DEEPSEEK_PRO_MODEL },
  { arm: 'flash', model: DEEPSEEK_FLASH_MODEL },
]

export interface DeepSeekTaskProfile {
  thinking: boolean
  stream: false
  maxTokens: number
  reasoningEffort: DeepSeekReasoningEffort | null
}

export interface DeepSeekTaskToolTraceEntry {
  name: string
  args: Record<string, unknown>
}

export interface DeepSeekTaskTool {
  definition: ModelFunctionTool
  run(args: Record<string, unknown>): unknown
}

export interface DeepSeekTaskCheckContext {
  output: Record<string, unknown>
  toolTrace: DeepSeekTaskToolTraceEntry[]
}

export interface DeepSeekTaskCheck {
  id: string
  points: number
  hardFailure?: boolean
  passes(context: DeepSeekTaskCheckContext): boolean
}

export interface DeepSeekTaskSpec {
  id: string
  category: string
  fixture: unknown
  promptVersion: string
  scorerVersion: string
  system: string
  prompt: string
  profile: DeepSeekTaskProfile
  routeFeatures: SubagentRouteFeatures
  tools?: readonly DeepSeekTaskTool[]
  checks: readonly DeepSeekTaskCheck[]
}

export interface DeepSeekTaskScore {
  earned: number
  max: 100
  pass: boolean
  hardFailures: string[]
  components: Record<string, number>
}

const JSON_SYSTEM = [
  'Solve the synthetic evaluation task exactly.',
  'Return one JSON object only, without Markdown or explanatory prose.',
  'Do not invent fields that the task does not request.',
].join(' ')

const TOOL_SYSTEM = [
  JSON_SYSTEM,
  'You must obtain the answer with the provided synthetic read-only tools.',
  'Never guess a fixture value.',
].join(' ')

const OFF_PROFILE: DeepSeekTaskProfile = {
  thinking: false,
  stream: false,
  maxTokens: 256,
  reasoningEffort: null,
}

const THINKING_PROFILE: DeepSeekTaskProfile = {
  thinking: true,
  stream: false,
  // DeepSeek V4 counts reasoning_content and the final JSON against the same output budget.
  // 512 repeatedly ended at finish_reason=length before the answer; 1536 leaves room for both.
  maxTokens: 1536,
  reasoningEffort: 'high',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function field(output: Record<string, unknown>, key: string): unknown {
  return output[key]
}

function stringEquals(key: string, expected: string): DeepSeekTaskCheck['passes'] {
  return ({ output }) => {
    const value = field(output, key)
    return typeof value === 'string' && value.toLowerCase() === expected.toLowerCase()
  }
}

function numberEquals(key: string, expected: number): DeepSeekTaskCheck['passes'] {
  return ({ output }) => field(output, key) === expected
}

function stringArrayEquals(
  key: string,
  expected: readonly string[],
): DeepSeekTaskCheck['passes'] {
  return ({ output }) => {
    const value = field(output, key)
    return Array.isArray(value)
      && value.length === expected.length
      && value.every((item, index) =>
        typeof item === 'string'
        && item.toLowerCase() === expected[index]?.toLowerCase())
  }
}

function stringSetEquals(
  key: string,
  expected: readonly string[],
): DeepSeekTaskCheck['passes'] {
  const expectedSet = new Set(expected.map((item) => item.toLowerCase()))
  return ({ output }) => {
    const value = field(output, key)
    if (!Array.isArray(value) || value.length !== expectedSet.size) return false
    const actual = value.filter((item): item is string => typeof item === 'string')
    return actual.length === value.length
      && new Set(actual.map((item) => item.toLowerCase())).size === expectedSet.size
      && actual.every((item) => expectedSet.has(item.toLowerCase()))
  }
}

function nestedTicketEquals(
  ticketId: string,
  label: string,
  severity: string,
): DeepSeekTaskCheck['passes'] {
  return ({ output }) => {
    const tickets = field(output, 'tickets')
    if (!isRecord(tickets) || !isRecord(tickets[ticketId])) return false
    const ticket = tickets[ticketId] as Record<string, unknown>
    return ticket.label === label && ticket.severity === severity
  }
}

function classificationEquals(
  changeId: string,
  expected: string,
): DeepSeekTaskCheck['passes'] {
  return ({ output }) => {
    const changes = field(output, 'changes')
    return isRecord(changes) && changes[changeId] === expected
  }
}

function edgeKey(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const [from, to] = value
  return typeof from === 'string' && typeof to === 'string'
    ? `${from.toLowerCase()}>${to.toLowerCase()}`
    : null
}

function requiredEdges(expected: readonly string[]): DeepSeekTaskCheck['passes'] {
  return ({ output }) => {
    const edges = field(output, 'edges')
    if (!Array.isArray(edges)) return false
    const actual = new Set(edges.map(edgeKey).filter((item): item is string => item !== null))
    return expected.every((item) => actual.has(item))
  }
}

function graphIsAcyclic({ output }: DeepSeekTaskCheckContext): boolean {
  const edges = field(output, 'edges')
  if (!Array.isArray(edges)) return false
  const adjacency = new Map<string, string[]>()
  for (const raw of edges) {
    if (!Array.isArray(raw) || raw.length !== 2) return false
    const [from, to] = raw
    if (typeof from !== 'string' || typeof to !== 'string') return false
    adjacency.set(from, [...(adjacency.get(from) ?? []), to])
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return false
    if (visited.has(node)) return true
    visiting.add(node)
    for (const child of adjacency.get(node) ?? []) {
      if (!visit(child)) return false
    }
    visiting.delete(node)
    visited.add(node)
    return true
  }
  return [...adjacency.keys()].every(visit)
}

function thresholdEquals(
  metric: string,
  operator: string,
  value: number,
): DeepSeekTaskCheck['passes'] {
  return ({ output }) => {
    const thresholds = field(output, 'abort_thresholds')
    if (!Array.isArray(thresholds)) return false
    return thresholds.some((candidate) =>
      isRecord(candidate)
      && candidate.metric === metric
      && candidate.operator === operator
      && candidate.value === value)
  }
}

function taskTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  run: DeepSeekTaskTool['run'],
): DeepSeekTaskTool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description,
        parameters: {
          type: 'object',
          properties,
          required,
          additionalProperties: false,
        },
      },
    },
    run,
  }
}

const SEARCH_DOCS = taskTool(
  'fixture_search_docs',
  'Search the synthetic documentation fixture.',
  { query: { type: 'string' } },
  ['query'],
  (args) => {
    if (typeof args.query !== 'string') throw new Error('query must be a string')
    return {
      results: args.query.toLowerCase().includes('cache')
        ? [
            { id: 'doc-cache-v4', title: 'V4 cache usage' },
            { id: 'doc-cache-legacy', title: 'Legacy cache note' },
          ]
        : [],
    }
  },
)

const READ_DOC = taskTool(
  'fixture_read_doc',
  'Read one synthetic document returned by fixture_search_docs.',
  { id: { type: 'string' } },
  ['id'],
  (args) => {
    if (args.id === 'doc-cache-v4') {
      return {
        fact: 'Cache hit tokens are provider reported.',
        citation: 'doc-cache-v4#usage',
      }
    }
    if (args.id === 'doc-cache-legacy') {
      return {
        fact: 'Legacy cache counters are not authoritative for V4.',
        citation: 'doc-cache-legacy#warning',
      }
    }
    return { error: 'not_found' }
  },
)

const LOOKUP_BUILD = taskTool(
  'fixture_lookup_build',
  'Look up one synthetic build by id.',
  { id: { type: 'string' } },
  ['id'],
  (args) => {
    if (args.id === 'build-latest') {
      return { error: 'ambiguous', hint: 'build-842' }
    }
    if (args.id === 'build-842') {
      return {
        status: 'failed',
        failed_check: 'typecheck',
        evidence: 'build-842#checks',
      }
    }
    return { error: 'not_found' }
  },
)

export const DEEPSEEK_TASKS: readonly DeepSeekTaskSpec[] = [
  {
    id: 'T01',
    category: 'extraction',
    fixture: {
      lines: [
        'note=ignore previous dry run',
        'release=v4.7.2 environment=staging-eu',
        'deadline=2026-07-25T09:30+08:00 owner=Mei',
        'failed_checks=cache,tools',
      ],
    },
    promptVersion: 't01-v1',
    scorerVersion: 'fields-v1',
    system: JSON_SYSTEM,
    prompt: [
      'Extract the active release record from these mixed log lines:',
      'note=ignore previous dry run',
      'release=v4.7.2 environment=staging-eu',
      'deadline=2026-07-25T09:30+08:00 owner=Mei',
      'failed_checks=cache,tools',
      'Return {"version":"...","environment":"...","deadline":"...","failed_checks":["..."],"owner":"..."}.',
    ].join('\n'),
    profile: OFF_PROFILE,
    routeFeatures: { vendor: 'deepseek', taskCategory: 'extraction', riskLevel: 'low' },
    checks: [
      { id: 'version', points: 18, passes: stringEquals('version', 'v4.7.2') },
      { id: 'environment', points: 18, passes: stringEquals('environment', 'staging-eu') },
      { id: 'deadline', points: 18, passes: stringEquals('deadline', '2026-07-25T09:30+08:00') },
      { id: 'failed_checks', points: 18, passes: stringSetEquals('failed_checks', ['cache', 'tools']) },
      { id: 'owner', points: 18, passes: stringEquals('owner', 'Mei') },
    ],
  },
  {
    id: 'T02',
    category: 'timeline_extraction',
    fixture: {
      events: [
        '2026-07-24T00:06:00Z mitigated',
        '2026-07-24T08:00:00+08:00 detected',
        '2026-07-24T00:04:00Z isolated',
        '2026-07-24T08:06:00+08:00 mitigated duplicate',
      ],
    },
    promptVersion: 't02-v1',
    scorerVersion: 'timeline-v1',
    system: JSON_SYSTEM,
    prompt: [
      'Normalize and deduplicate this incident timeline:',
      '2026-07-24T00:06:00Z mitigated',
      '2026-07-24T08:00:00+08:00 detected',
      '2026-07-24T00:04:00Z isolated',
      '2026-07-24T08:06:00+08:00 mitigated duplicate',
      'Return {"events":[event names in order],"duration_minutes":number,"unique_event_count":number}.',
    ].join('\n'),
    profile: OFF_PROFILE,
    routeFeatures: {
      vendor: 'deepseek',
      taskCategory: 'extraction',
      riskLevel: 'low',
      requiresTemporalNormalization: true,
    },
    checks: [
      { id: 'event_order', points: 40, passes: stringArrayEquals('events', ['detected', 'isolated', 'mitigated']) },
      { id: 'duration', points: 30, passes: numberEquals('duration_minutes', 6) },
      { id: 'deduplicated', points: 20, passes: numberEquals('unique_event_count', 3) },
    ],
  },
  {
    id: 'T03',
    category: 'classification',
    fixture: {
      tickets: {
        A: 'The settings page crashes after save.',
        B: 'How do I export a run?',
        C: 'My invoice total is duplicated.',
        D: 'A public link exposes a private token.',
        E: 'The retry button stays disabled.',
        F: 'Where is the cache documentation?',
      },
    },
    promptVersion: 't03-v1',
    scorerVersion: 'classification-v1',
    system: JSON_SYSTEM,
    prompt: [
      'Classify each ticket as bug, howto, billing, or security, and assign severity P0-P3.',
      'A: The settings page crashes after save.',
      'B: How do I export a run?',
      'C: My invoice total is duplicated.',
      'D: A public link exposes a private token.',
      'E: The retry button stays disabled.',
      'F: Where is the cache documentation?',
      'Rules: exposed secrets=P0; crashes and blocked actions=P1; billing=P2; howto=P3.',
      'Return {"tickets":{"A":{"label":"...","severity":"..."}...}}.',
    ].join('\n'),
    profile: OFF_PROFILE,
    routeFeatures: { vendor: 'deepseek', taskCategory: 'analysis', riskLevel: 'medium' },
    checks: [
      { id: 'ticket_A', points: 15, passes: nestedTicketEquals('A', 'bug', 'P1') },
      { id: 'ticket_B', points: 15, passes: nestedTicketEquals('B', 'howto', 'P3') },
      { id: 'ticket_C', points: 15, passes: nestedTicketEquals('C', 'billing', 'P2') },
      {
        id: 'ticket_D_security',
        points: 15,
        hardFailure: true,
        passes: nestedTicketEquals('D', 'security', 'P0'),
      },
      { id: 'ticket_E', points: 15, passes: nestedTicketEquals('E', 'bug', 'P1') },
      { id: 'ticket_F', points: 15, passes: nestedTicketEquals('F', 'howto', 'P3') },
    ],
  },
  {
    id: 'T04',
    category: 'change_safety',
    fixture: {
      rules: ['read-only docs=safe', 'test-only=review', 'secret logging=block', 'schema delete=block'],
      changes: ['A docs typo', 'B new unit test', 'C log auth header', 'D drop users column', 'E rename local variable'],
    },
    promptVersion: 't04-v1',
    scorerVersion: 'classification-v1',
    system: JSON_SYSTEM,
    prompt: [
      'Classify each change as safe, review, or block.',
      'Rules: read-only docs or local rename=safe; test-only=review; secret logging or schema deletion=block.',
      'A: fix a docs typo',
      'B: add a unit test only',
      'C: log the Authorization header',
      'D: drop the users.email column',
      'E: rename a local variable',
      'Return {"changes":{"A":"safe",...}}.',
    ].join('\n'),
    profile: OFF_PROFILE,
    routeFeatures: { vendor: 'deepseek', taskCategory: 'verification', riskLevel: 'medium' },
    checks: [
      { id: 'change_A', points: 18, passes: classificationEquals('A', 'safe') },
      { id: 'change_B', points: 18, passes: classificationEquals('B', 'review') },
      {
        id: 'change_C_secret',
        points: 18,
        hardFailure: true,
        passes: classificationEquals('C', 'block'),
      },
      {
        id: 'change_D_schema',
        points: 18,
        hardFailure: true,
        passes: classificationEquals('D', 'block'),
      },
      { id: 'change_E', points: 18, passes: classificationEquals('E', 'safe') },
    ],
  },
  {
    id: 'T05',
    category: 'migration_planning',
    fixture: {
      requiredNodes: ['schema', 'api', 'ui', 'verify'],
      requiredEdges: ['schema>api', 'api>ui', 'ui>verify'],
      forbiddenOperation: 'drop_table',
    },
    promptVersion: 't05-v2',
    scorerVersion: 'dag-v2',
    system: JSON_SYSTEM,
    prompt: [
      'Plan a four-stage migration with nodes schema, api, ui, verify.',
      'Constraints: schema before api; api before ui; ui before verify; never drop a table.',
      'The rollback point is before_api.',
      'Return {"nodes":[],"edges":[["from","to"]],"rollback_point":"...","planned_ops":[],"forbidden_ops":["drop_table"]}.',
      'planned_ops lists operations the plan will execute; forbidden_ops explicitly names prohibited operations.',
    ].join('\n'),
    profile: THINKING_PROFILE,
    routeFeatures: {
      vendor: 'deepseek',
      taskCategory: 'implementation',
      riskLevel: 'medium',
      crossModule: true,
    },
    checks: [
      { id: 'required_nodes', points: 20, passes: stringSetEquals('nodes', ['schema', 'api', 'ui', 'verify']) },
      { id: 'required_edges', points: 25, passes: requiredEdges(['schema>api', 'api>ui', 'ui>verify']) },
      { id: 'acyclic', points: 15, hardFailure: true, passes: graphIsAcyclic },
      { id: 'rollback', points: 15, passes: stringEquals('rollback_point', 'before_api') },
      {
        id: 'forbidden_operation_guard',
        points: 15,
        hardFailure: true,
        passes: ({ output }) => {
          const plannedOperations = field(output, 'planned_ops')
          const forbiddenOperations = field(output, 'forbidden_ops')
          return Array.isArray(plannedOperations)
            && Array.isArray(forbiddenOperations)
            && !plannedOperations.some((item) =>
              typeof item === 'string' && item.toLowerCase() === 'drop_table')
            && forbiddenOperations.some((item) =>
              typeof item === 'string' && item.toLowerCase() === 'drop_table')
        },
      },
    ],
  },
  {
    id: 'T06',
    category: 'canary_planning',
    fixture: {
      phases: [5, 25, 100],
      abortThresholds: [
        { metric: 'error_rate_percent', operator: '>', value: 2 },
        { metric: 'p95_ms', operator: '>', value: 800 },
      ],
    },
    promptVersion: 't06-v2',
    scorerVersion: 'canary-v1',
    system: JSON_SYSTEM,
    prompt: [
      'Create a canary plan with traffic phases 5%, 25%, 100% in that order.',
      'Encode phases as the numeric percentages [5,25,100], without percent signs or objects.',
      'Abort and roll back if error_rate_percent > 2 or p95_ms > 800.',
      'Rollback target is previous_version.',
      'Return {"phases":[],"abort_thresholds":[{"metric":"...","operator":">","value":0}],"abort_action":"...","rollback_target":"..."}.',
    ].join('\n'),
    profile: THINKING_PROFILE,
    routeFeatures: { vendor: 'deepseek', taskCategory: 'analysis', riskLevel: 'medium' },
    checks: [
      {
        id: 'phases',
        points: 20,
        passes: ({ output }) => {
          const phases = field(output, 'phases')
          return Array.isArray(phases)
            && phases.length === 3
            && phases.every((item, index) => item === [5, 25, 100][index])
        },
      },
      { id: 'error_threshold', points: 20, passes: thresholdEquals('error_rate_percent', '>', 2) },
      { id: 'latency_threshold', points: 20, passes: thresholdEquals('p95_ms', '>', 800) },
      { id: 'abort_action', points: 15, hardFailure: true, passes: stringEquals('abort_action', 'rollback') },
      { id: 'rollback_target', points: 15, passes: stringEquals('rollback_target', 'previous_version') },
    ],
  },
  {
    id: 'T07',
    category: 'debugging',
    fixture: {
      code: 'setSaving(true); await persist(); setSaving(false)',
      failure: 'persist rejects',
    },
    promptVersion: 't07-v1',
    scorerVersion: 'causal-tuple-v1',
    system: JSON_SYSTEM,
    prompt: [
      'Diagnose this async state bug:',
      'setSaving(true); await persist(); setSaving(false)',
      'When persist rejects, saving remains true.',
      'Return {"root_cause":"...","evidence":"...","patch":"...","regression":"..."}.',
      'Use the canonical tokens: missing_finally, persist_rejection_skips_reset, try_finally, saving_false_on_reject.',
    ].join('\n'),
    profile: THINKING_PROFILE,
    routeFeatures: { vendor: 'deepseek', taskCategory: 'implementation', riskLevel: 'medium' },
    checks: [
      { id: 'root_cause', points: 25, passes: stringEquals('root_cause', 'missing_finally') },
      { id: 'evidence', points: 20, passes: stringEquals('evidence', 'persist_rejection_skips_reset') },
      { id: 'patch', points: 25, passes: stringEquals('patch', 'try_finally') },
      { id: 'regression', points: 20, passes: stringEquals('regression', 'saving_false_on_reject') },
    ],
  },
  {
    id: 'T08',
    category: 'trace_debugging',
    fixture: {
      trace: ['controller', 'retry', 'writer'],
      symptom: 'writer commits, response times out, retry duplicates side effect',
    },
    promptVersion: 't08-v1',
    scorerVersion: 'causal-tuple-v1',
    system: JSON_SYSTEM,
    prompt: [
      'A controller calls retry, which calls writer.',
      'Writer commits the side effect, but its response times out. Retry invokes writer again and duplicates it.',
      'Return {"root_cause":"...","call_path":[],"change_module":"...","regression":"..."}.',
      'Use canonical tokens: missing_idempotency, controller/retry/writer, writer, same_key_single_effect.',
    ].join('\n'),
    profile: THINKING_PROFILE,
    routeFeatures: { vendor: 'deepseek', taskCategory: 'verification', riskLevel: 'medium' },
    checks: [
      { id: 'root_cause', points: 25, passes: stringEquals('root_cause', 'missing_idempotency') },
      { id: 'call_path', points: 20, passes: stringArrayEquals('call_path', ['controller', 'retry', 'writer']) },
      { id: 'change_module', points: 25, passes: stringEquals('change_module', 'writer') },
      { id: 'regression', points: 20, passes: stringEquals('regression', 'same_key_single_effect') },
    ],
  },
  {
    id: 'T09',
    category: 'tool_selection',
    fixture: {
      query: 'V4 cache usage provider reported',
      authoritativeDocument: 'doc-cache-v4',
    },
    promptVersion: 't09-v1',
    scorerVersion: 'tool-trace-v2',
    system: TOOL_SYSTEM,
    prompt: [
      'Find the authoritative V4 cache-usage statement.',
      'Search the fixture, read the correct document, then return {"fact":"...","citation":"..."}.',
    ].join('\n'),
    profile: OFF_PROFILE,
    routeFeatures: { vendor: 'deepseek', taskCategory: 'retrieval', riskLevel: 'low' },
    tools: [SEARCH_DOCS, READ_DOC],
    checks: [
      {
        id: 'fact',
        points: 35,
        passes: stringEquals('fact', 'Cache hit tokens are provider reported.'),
      },
      { id: 'citation', points: 25, passes: stringEquals('citation', 'doc-cache-v4#usage') },
      {
        id: 'tool_trace_required',
        points: 20,
        hardFailure: true,
        passes: ({ toolTrace }) =>
          toolTrace[0]?.name === 'fixture_search_docs'
          && typeof toolTrace[0].args.query === 'string'
          && toolTrace[0].args.query.toLowerCase().includes('cache')
          && toolTrace.some((entry) =>
            entry.name === 'fixture_read_doc'
            && entry.args.id === 'doc-cache-v4'),
      },
      {
        id: 'tool_trace_efficiency',
        points: 10,
        passes: ({ toolTrace }) =>
          toolTrace.length === 2
          && toolTrace[1]?.name === 'fixture_read_doc'
          && toolTrace[1].args.id === 'doc-cache-v4',
      },
    ],
  },
  {
    id: 'T10',
    category: 'tool_recovery',
    fixture: {
      initialId: 'build-latest',
      hint: 'build-842',
    },
    promptVersion: 't10-v1',
    scorerVersion: 'tool-trace-v1',
    system: TOOL_SYSTEM,
    prompt: [
      'Look up build-latest.',
      'If the tool returns a corrected id hint, recover by looking up that id once.',
      'Return {"status":"...","failed_check":"...","evidence":"..."}.',
    ].join('\n'),
    profile: OFF_PROFILE,
    routeFeatures: { vendor: 'deepseek', taskCategory: 'retrieval', riskLevel: 'low' },
    tools: [LOOKUP_BUILD],
    checks: [
      { id: 'status', points: 20, passes: stringEquals('status', 'failed') },
      { id: 'failed_check', points: 20, passes: stringEquals('failed_check', 'typecheck') },
      { id: 'evidence', points: 20, passes: stringEquals('evidence', 'build-842#checks') },
      {
        id: 'tool_recovery_trace',
        points: 30,
        hardFailure: true,
        passes: ({ toolTrace }) =>
          toolTrace.length === 2
          && toolTrace[0]?.name === 'fixture_lookup_build'
          && toolTrace[0].args.id === 'build-latest'
          && toolTrace[1]?.name === 'fixture_lookup_build'
          && toolTrace[1].args.id === 'build-842',
      },
    ],
  },
]

export function shadowRouteForTask(task: DeepSeekTaskSpec): SubagentRouteDecision {
  return routeSubagentModel({
    ...task.routeFeatures,
    // The task suite evaluates first-level child routing. Leaving this undefined would correctly
    // trigger the production fail-closed unknown-parent-path guard, but would not model this suite.
    parentPath: task.routeFeatures.parentPath ?? ROOT_AGENT_PATH,
  })
}

export function scoreDeepSeekTask(
  task: DeepSeekTaskSpec,
  output: unknown,
  toolTrace: DeepSeekTaskToolTraceEntry[],
): DeepSeekTaskScore {
  if (!isRecord(output)) {
    return {
      earned: 0,
      max: 100,
      pass: false,
      hardFailures: ['invalid_json_object'],
      components: { schema: 0 },
    }
  }

  const context = { output, toolTrace }
  const components: Record<string, number> = { schema: 10 }
  const hardFailures: string[] = []
  for (const check of task.checks) {
    const passed = check.passes(context)
    components[check.id] = passed ? check.points : 0
    if (!passed && check.hardFailure) hardFailures.push(check.id)
  }
  const earned = Object.values(components).reduce((sum, points) => sum + points, 0)
  return {
    earned,
    max: 100,
    pass: earned >= 80 && hardFailures.length === 0,
    hardFailures,
    components,
  }
}

export function taskLaneOrder(
  taskId: string,
  replicate = 0,
): readonly DeepSeekTaskLane[] {
  const numericId = Number.parseInt(taskId.replace(/\D/g, ''), 10)
  return (numericId + replicate) % 2 === 0
    ? [DEEPSEEK_TASK_LANES[1]!, DEEPSEEK_TASK_LANES[0]!]
    : DEEPSEEK_TASK_LANES
}
