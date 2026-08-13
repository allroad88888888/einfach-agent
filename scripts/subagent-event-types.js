// Keep this Node-side registry in lockstep with the stable subagents archive schema.
export const SUBAGENT_EVENT_TYPES = [
  'archive_initialized',
  'delegate_requested',
  'children_reserved',
  'skill_written',
  'child_started',
  'child_tool_schema_requested',
  'child_tool_finished',
  'nested_delegate_requested',
  'child_finished',
  'tree_snapshot_written',
  'delegate_finished',
  'child_model_usage',
  'child_model_escalated',
  'child_context_distillation_started',
  'child_context_distillation_succeeded',
  'child_context_distillation_failed',
]

/** Creates a zeroed replay counter for every supported archive event. */
export function createSubagentEventCounts() {
  return Object.fromEntries(SUBAGENT_EVENT_TYPES.map((type) => [type, 0]))
}
