// Checkpoint 状态的兼容读取：新数据读结构化字段，旧数据才回退解析历史展示前缀。

import type {
  CheckpointFinishReason,
  CheckpointKind,
  CheckpointState,
} from './checkpoint.type'

interface LegacyLabelState {
  prefix: string
  kind: CheckpointKind
  finishReason?: CheckpointFinishReason
}

const LEGACY_LABEL_STATES: LegacyLabelState[] = [
  { prefix: '[执行中] ', kind: 'working' },
  { prefix: '[已停止] ', kind: 'stopped' },
  { prefix: '[截断] ', kind: 'abnormal', finishReason: 'length' },
  { prefix: '[已拦截] ', kind: 'abnormal', finishReason: 'content_filter' },
  { prefix: '[已中断] ', kind: 'abnormal', finishReason: 'insufficient_system_resource' },
]

type CheckpointStateSource = Partial<CheckpointState> & { label: string }

export function readCheckpointState(checkpoint: CheckpointStateSource): CheckpointState {
  if (checkpoint.kind) {
    return { kind: checkpoint.kind, finishReason: checkpoint.finishReason }
  }
  const legacyState = LEGACY_LABEL_STATES.find(({ prefix }) => checkpoint.label.startsWith(prefix))
  return legacyState
    ? { kind: legacyState.kind, finishReason: legacyState.finishReason }
    : { kind: 'completed' }
}
